import {SpatialIndex} from './spatial-index.js';

const DATA_URL = '/offline-map/data/basemap.json';
const PANE_NAME = 'offlineBasemapPane';
const WORLD = 360;

function eachPosition(value, visit) {
  const stack = [value];
  while (stack.length) {
    const item = stack.pop();
    if (!Array.isArray(item)) continue;
    if (item.length >= 2 && typeof item[0] === 'number' && typeof item[1] === 'number') visit(item[0], item[1]);
    else for (let i = item.length - 1; i >= 0; i--) stack.push(item[i]);
  }
}

function featureBounds(feature) {
  const coordinates = feature?.geometry?.coordinates;
  if (!coordinates) return null;
  let west = Infinity, east = -Infinity, south = Infinity, north = -Infinity;
  eachPosition(coordinates, (lon, lat) => {
    west = Math.min(west, lon); east = Math.max(east, lon);
    south = Math.min(south, lat); north = Math.max(north, lat);
  });
  return Number.isFinite(west) ? {west, east, south, north} : null;
}

function featureIsVisible(bounds, view) {
  if (!bounds || bounds.north < view.south || bounds.south > view.north) return false;
  if (view.east - view.west >= WORLD) return true;
  // Match whichever world copy intersects, including maps panned several worlds away.
  const firstCopy = Math.ceil((view.west - bounds.east) / WORLD);
  const lastCopy = Math.floor((view.east - bounds.west) / WORLD);
  return firstCopy <= lastCopy;
}

function collectionFeatures(value) {
  if (!value) return [];
  if (value.type === 'FeatureCollection' && Array.isArray(value.features)) return value.features;
  if (value.type === 'Feature') return [value];
  return [];
}

function cityItems(dataset) {
  if (Array.isArray(dataset.cities)) return dataset.cities;
  return collectionFeatures(dataset.cities).map(feature => ({
    ...feature.properties,
    lat: feature.geometry?.coordinates?.[1],
    lon: feature.geometry?.coordinates?.[0]
  }));
}

function viewport(map) {
  const bounds = map.getBounds();
  return {
    west: bounds.getWest(), east: bounds.getEast(),
    south: bounds.getSouth(), north: bounds.getNorth()
  };
}

// Leaflet does not wrap vector paths the way it wraps raster tiles. Position each
// disconnected component in the nearest world copy; never join across ±180°.
function wrappedGeometry(geometry, centerLon) {
  const copies=[];
  const shiftPositions=(coordinates,shift)=>{
    if(typeof coordinates[0]==='number')return [coordinates[0]+shift,...coordinates.slice(1)];
    return coordinates.map(child=>shiftPositions(child,shift));
  };
  const component=coordinates=>{
    let min=Infinity,max=-Infinity;
    eachPosition(coordinates,lon=>{min=Math.min(min,lon);max=Math.max(max,lon);});
    const shift=360*Math.round((centerLon-(min+max)/2)/360);
    copies.push(shift);
    return shiftPositions(coordinates,shift);
  };
  const multiple=['MultiPolygon','MultiLineString','MultiPoint'].includes(geometry.type);
  const coordinates=multiple?geometry.coordinates.map(component):component(geometry.coordinates);
  return {...geometry,coordinates,_worldCopies:copies.join(',')};
}
const wrappedLongitude=(lon,center)=>Number(lon)+360*Math.round((center-Number(lon))/360);

function intersectsCity(city, view) {
  if (!Number.isFinite(Number(city.lat)) || !Number.isFinite(Number(city.lon))) return false;
  return Number(city.lat) >= view.south && Number(city.lat) <= view.north &&
    featureIsVisible({west:Number(city.lon), east:Number(city.lon), south:Number(city.lat), north:Number(city.lat)}, view);
}

function collisionSafeCities(L, map, cities, view, zoom) {
  const candidates = cities
    .filter(city => city.name && Number(city.minZoom ?? 5) <= zoom && zoom<=Number(city.maxZoom??Infinity) && intersectsCity(city, view))
    .map(city => ({city, point:map.latLngToContainerPoint([Number(city.lat), wrappedLongitude(city.lon,map.getCenter().lng)]),
      priority:Number(city.population ?? city.priority ?? 0)}))
    .filter(item => item.point.x >= -80 && item.point.x <= map.getSize().x + 80 && item.point.y >= -40 && item.point.y <= map.getSize().y + 40)
    .sort((a,b) => b.priority-a.priority || String(a.city.name).localeCompare(String(b.city.name), 'zh-Hans-CN'));

  const chosen = [];
  for (const item of candidates) {
    const width = Math.max(42, String(item.city.name).length * 13);
    const crowded = chosen.some(other => Math.abs(other.point.x-item.point.x) < (width + other.width)/2 + 8 &&
      Math.abs(other.point.y-item.point.y) < 25);
    if (!crowded) chosen.push({...item, width});
  }
  return chosen.map(item=>item.city);
}

/** Install the bundled vector basemap before callers add network tiles. */
export async function installOfflineBasemap(L, map) {
  if (!L || !map) throw new TypeError('Leaflet and map are required');
  if (map.__offlineBasemapController) {
    await map.__offlineBasemapController.readyPromise;
    return map.__offlineBasemapController;
  }
  const response = await fetch(DATA_URL, {cache:'force-cache'});
  if (!response.ok) throw new Error(`Offline basemap unavailable (${response.status})`);
  const dataset = await response.json();
  const container = map.getContainer();
  container.classList.add('offline-map-enabled');
  let pane = map.getPane(PANE_NAME);
  if (!pane) pane = map.createPane(PANE_NAME);
  pane.style.zIndex = '190';
  pane.style.pointerEvents = 'none';
  const renderer = L.canvas ? L.canvas({pane:PANE_NAME, padding:0.25}) : undefined;
  const layers = new Map();
  const groups = Object.fromEntries(['countries','admin','lakes','roads','urban'].map(key => [key, []]));
  const indexes = Object.fromEntries(Object.keys(groups).map(key => [key, new SpatialIndex()]));
  const featuresByKey = Object.fromEntries(Object.keys(groups).map(key => [key, collectionFeatures(dataset[key])]));
  const countries=featuresByKey.countries.map(feature=>({name:feature.properties?.name,lat:feature.properties?.labelLat,lon:feature.properties?.labelLon,minZoom:2,maxZoom:3,priority:1000})).filter(c=>Number.isFinite(c.lat)&&Number.isFinite(c.lon));
  const cities = [...countries,...cityItems(dataset)];
  const cityIndex = new SpatialIndex();
  let indexesReady = false;
  let indexBuildCancelled = false;
  const styles = {
    countries:{color:'#b8b8b2',weight:0.65,opacity:0.9,fillColor:'#f4f2eb',fillOpacity:0.94},
    admin:{color:'#c4c3bc',weight:0.48,opacity:0.78,fill:false},
    lakes:{color:'#a9cedb',weight:0.45,opacity:0.8,fillColor:'#d5e9ef',fillOpacity:0.96},
    roads:{color:'#cdbb9d',weight:1.1,opacity:0.9,fill:false},
    urban:{color:'#e7e1d4',weight:0.35,opacity:0.45,fillColor:'#e7e1d4',fillOpacity:0.6}
  };
  const enabledAtZoom = {countries:0, admin:4, lakes:0, roads:6, urban:7};
  let disposed = false;
  let visibleCounts = {};

  function sync() {
    if (disposed || !indexesReady) return;
    const view = viewport(map), zoom = map.getZoom(), active = new Set();
    for (const key of ['countries','urban','admin','lakes','roads']) {
      if (zoom < enabledAtZoom[key]) continue;
      let visible = 0;
      const entries = [...indexes[key].query(view)].filter(entry => featureIsVisible(entry.bounds, view)).sort((a,b)=>a.index-b.index);
      for (const entry of entries) {
        visible++;
        const geometry=wrappedGeometry(entry.feature.geometry,map.getCenter().lng);
        const id = `${key}:${entry.feature.id ?? entry.index}:${geometry._worldCopies}`;
        active.add(id);
        let layer = layers.get(id);
        if (!layer) {
          const feature={...entry.feature,geometry};
          layer = L.geoJSON(feature, {pane:PANE_NAME, renderer, style:styles[key], interactive:false, smoothFactor:1.5});
          layers.set(id, layer);
        }
        if (!map.hasLayer(layer)){layer.addTo(map);if(key==='countries')layer.eachLayer(child=>child.bringToBack?.());}
      }
      visibleCounts[key] = visible;
    }
    for (const [id, layer] of layers) if (!id.startsWith('city:') && !active.has(id)){if(map.hasLayer(layer))map.removeLayer(layer);layers.delete(id);}
    // Newly appearing filled polygons must not cover already-visible roads.
    for(const [id,layer] of layers)if(id.startsWith('roads:')&&active.has(id))layer.eachLayer(child=>child.bringToFront?.());

    const selected = collisionSafeCities(L, map, [...cityIndex.query(view)].map(entry=>entry.city), view, zoom);
    const cityId = city => `city:${city.id ?? `${city.name}:${city.lat}:${city.lon}`}`;
    const visibleCities = new Set(selected.map(cityId));
    for (const city of selected) {
      const id = cityId(city);
      let layer = layers.get(id);
      if (!layer) {
        const icon = L.divIcon({className:'offline-map-city-icon', html:`<span class="offline-map-city">${escapeText(city.name)}</span>`, iconSize:null, iconAnchor:[0,0]});
        layer = L.marker([Number(city.lat),wrappedLongitude(city.lon,map.getCenter().lng)], {pane:PANE_NAME, icon, keyboard:false, interactive:false, zIndexOffset:1000});
        layers.set(id, layer);
      }
      layer.setLatLng([Number(city.lat),wrappedLongitude(city.lon,map.getCenter().lng)]);
      if (!map.hasLayer(layer)) layer.addTo(map);
    }
    for (const [id, layer] of layers) if (id.startsWith('city:') && !visibleCities.has(id)){if(map.hasLayer(layer))map.removeLayer(layer);layers.delete(id);}
    for (const key of ['countries','admin','lakes','roads','urban']) if (zoom < enabledAtZoom[key]) visibleCounts[key] = 0;
    visibleCounts.cities = selected.length;
  }

  function buildSpatialIndexes() {
    const keys = Object.keys(groups);
    let groupCursor = 0, featureCursor = 0, cityCursor = 0;
    return new Promise(resolve => {
      const runBatch = () => {
        if (indexBuildCancelled || disposed) { resolve(); return; }
        const start = globalThis.performance?.now?.() ?? Date.now();
        let count = 0;
        while ((groupCursor < keys.length || cityCursor < cities.length) && count < 1024 && ((globalThis.performance?.now?.() ?? Date.now()) - start) < 8) {
        while (groupCursor < keys.length && featureCursor >= featuresByKey[keys[groupCursor]].length) {
          groupCursor++;
          featureCursor=0;
        }
        if (groupCursor < keys.length) {
            const key = keys[groupCursor], features = featuresByKey[key];
            const feature = features[featureCursor];
            const entry = {feature,bounds:featureBounds(feature),index:featureCursor};
            if (entry.bounds) { groups[key].push(entry); indexes[key].add(entry); }
            featureCursor++;
            if (featureCursor >= features.length) { groupCursor++; featureCursor=0; }
          } else {
            const city = cities[cityCursor++];
            const lat=Number(city.lat), lon=Number(city.lon);
            if (Number.isFinite(lat) && Number.isFinite(lon)) cityIndex.add({city,bounds:{west:lon,east:lon,south:lat,north:lat}});
          }
          count++;
        }
        if (groupCursor < keys.length || cityCursor < cities.length) setTimeout(runBatch, 0);
        else { indexesReady = true; sync(); resolve(); }
      };
      setTimeout(runBatch, 0);
    });
  }

  function escapeText(value) {
    return String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  }

  container.dataset.offlineBasemap = 'indexing';
  const controller = {
    dataset,
    refresh:sync,
    getVisibleCounts:()=>({...visibleCounts}),
    remove(){disposed=true;indexBuildCancelled=true;map.off('moveend zoomend resize',sync);for(const layer of layers.values())if(map.hasLayer(layer))map.removeLayer(layer);layers.clear();delete container.dataset.offlineBasemap;container.classList.remove('offline-map-enabled');delete map.__offlineBasemapController;},
    get ready(){return container.dataset.offlineBasemap === 'ready';}
  };
  map.__offlineBasemapController = controller;
  map.on('moveend zoomend resize', sync);
  controller.readyPromise = buildSpatialIndexes().then(() => {
    if (!disposed) container.dataset.offlineBasemap = 'ready';
  });
  await controller.readyPromise;
  return controller;
}
