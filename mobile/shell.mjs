import {airlineForFlight, normalizeAircraftType} from '../dist/aviation.js';

const $ = selector => document.querySelector(selector);
const element = (tag, className, text) => {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (text != null) item.textContent = text;
  return item;
};

const tabs = [
  {id:'map', label:'地图', icon:'<path d="M3 6.5 8 4l8 3 5-2.5v13L16 20l-8-3-5 2.5z"/><path d="M8 4v13m8-10v13"/>'},
  {id:'add', label:'添加行程', icon:'<path d="M12 5v14m-7-7h14"/>'},
  {id:'history', label:'历史行程', icon:'<path d="M3 12a9 9 0 1 0 2.64-6.36L3 8"/><path d="M3 3v5h5m4-1v5l3 2"/>'},
  {id:'settings', label:'设置', icon:'<path d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z"/><path d="m19.4 15 .1.1 1.4 1.1-1.4 2.4-1.7-.6a8 8 0 0 1-1.5.9l-.3 1.8h-2.8l-.3-1.8a8 8 0 0 1-1.5-.9l-1.7.6-1.4-2.4 1.4-1.1a7 7 0 0 1 0-1.8l-1.4-1.1 1.4-2.4 1.7.6a8 8 0 0 1 1.5-.9l.3-1.8h2.8l.3 1.8a8 8 0 0 1 1.5.9l1.7-.6 1.4 2.4-1.4 1.1a7 7 0 0 1-.1 1.7Z" transform="translate(-1 -1) scale(.92)"/>'}
];

function rankTrips(trips, keyFor, labelFor, metaFor) {
  const groups = new Map();
  for (const trip of trips) {
    const id = keyFor(trip);
    if (!id) continue;
    const entry = groups.get(id) ?? {count:0, label:labelFor(trip), meta:metaFor(trip)};
    entry.count++;
    groups.set(id, entry);
  }
  return [...groups.values()].sort((a,b) => b.count-a.count || a.label.localeCompare(b.label,'zh-CN'));
}

function renderRanking(root, entries, {limit=null, carrier=false}={}) {
  root.replaceChildren();
  const shown = limit == null ? entries : entries.slice(0, limit);
  for (const [index, entry] of shown.entries()) {
    const row = element('li','ranking-item');
    row.append(element('span','ranking-order',String(index+1).padStart(2,'0')));
    const copy = element('div','ranking-copy');
    const title = element('strong','',entry.label);
    if (carrier) {
      const airline = entry.airline;
      const mark = element('span','carrier-logo ranking-carrier');
      mark.style.setProperty('--carrier-color',airline.color);
      mark.title = airline.name;
      if (airline.logo) {
        const image = element('img'); image.src=airline.logo; image.alt=airline.name;
        image.onerror=()=>{image.remove();mark.textContent=airline.code;}; mark.append(image);
      } else mark.textContent=airline.code;
      title.prepend(mark);
    }
    copy.append(title,element('span','',entry.meta));
    row.append(copy,element('span','ranking-count',`${entry.count} 次`));
    root.append(row);
  }
}

export function installMobileShell() {
  const main = $('main');
  const workspace = $('.workspace');
  const mapPanel = $('.map-panel');
  const capturePanel = $('.capture-panel');
  const itineraryPanel = $('.itinerary-panel');
  const topbar = $('.topbar');
  if (!main || !workspace || !mapPanel || !capturePanel || !itineraryPanel || !topbar) {
    throw new Error('移动页面结构不完整，无法安装底部导航。');
  }

  $('.page-heading')?.setAttribute('hidden','');
  $('.header-right')?.setAttribute('hidden','');
  $('footer')?.setAttribute('hidden','');
  $('.brand small')?.setAttribute('hidden','');

  const shell = element('div','mobile-shell');
  const panes = element('div','mobile-panes');
  const paneFor = (id, label) => {
    const pane = element('section','mobile-pane');
    pane.id = `mobile-pane-${id}`;
    pane.setAttribute('aria-label',label);
    pane.setAttribute('role','tabpanel');
    pane.hidden = true;
    return pane;
  };
  const mapPane = paneFor('map','航班地图');
  const addPane = paneFor('add','添加行程');
  const historyPane = paneFor('history','历史');
  const settingsPane = paneFor('settings','设置');
  const historyTabs = element('div','mobile-history-tabs');
  historyTabs.setAttribute('role','tablist');
  const statsButton = element('button','mobile-history-tab','历史统计');
  statsButton.type='button'; statsButton.dataset.historyView='stats'; statsButton.setAttribute('role','tab'); statsButton.setAttribute('aria-selected','true');
  const tripsButton = element('button','mobile-history-tab','具体行程');
  tripsButton.type='button'; tripsButton.dataset.historyView='list'; tripsButton.setAttribute('role','tab'); tripsButton.setAttribute('aria-selected','false');
  const statsView = element('div','mobile-stats-view');
  itineraryPanel.hidden=true;
  statsView.id='mobile-stats-view'; statsView.setAttribute('role','tabpanel');
  const statsToolbar = element('div','mobile-stats-toolbar');
  const summary = element('p','mobile-stats-summary','读取历史行程后生成榜单');
  summary.id='stats-summary';
  summary.setAttribute('aria-live','polite');
  const refreshButton = element('button','button secondary','刷新统计');
  refreshButton.type='button';
  const statsStatus = element('p','status mobile-stats-status','');
  statsStatus.setAttribute('role','status');
  statsToolbar.append(summary,refreshButton,statsStatus);
  const statsGrid = element('div','mobile-stats-grid');
  const makeStatsCard = (eyebrow,title,id) => {
    const card=element('article','stats-card');
    card.append(element('p','eyebrow',eyebrow),element('h2','',title));
    const list=element('ol','ranking-list'); list.id=id; card.append(list);
    return {card,list};
  };
  const routeCard=makeStatsCard('ROUTES','航线排行榜（前 10）','route-ranking');
  const airlineCard=makeStatsCard('AIRLINES','航司排行榜','airline-ranking');
  const aircraftCard=makeStatsCard('AIRCRAFT','机型排行榜','aircraft-ranking');
  statsGrid.append(routeCard.card,airlineCard.card,aircraftCard.card);
  statsView.append(statsToolbar,statsGrid);

  const settingsHeading=element('div','mobile-settings-heading');
  settingsHeading.append(element('div','', '设置'),element('p','muted','管理识别接口与本机数据备份。'));
  const settingsButton=$('#settings-button');
  if (settingsButton) { settingsButton.classList.add('button','secondary','mobile-api-settings'); settingsHeading.append(settingsButton); }
  const signout=$('#cloud-signout');
  if(signout)settingsHeading.append(signout);
  const dataTools=element('section','mobile-data-tools'); dataTools.id='mobile-data-tools';
  dataTools.append(element('h2','','数据备份'));
  dataTools.append(element('p','muted','导入会合并航班并跳过重复记录。导出包含航班和资料缓存，不包含 API Key。'));

  const nav=element('nav','mobile-tabbar');
  nav.setAttribute('aria-label','主要导航');
  nav.setAttribute('role','tablist');
  const buttons=new Map();
  for (const tab of tabs) {
    const button=element('button','mobile-tab',tab.label);
    button.type='button'; button.dataset.tab=tab.id;
    button.setAttribute('role','tab'); button.setAttribute('aria-controls',`mobile-pane-${tab.id}`);
    const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
    svg.setAttribute('viewBox','0 0 24 24'); svg.setAttribute('fill','none'); svg.setAttribute('stroke','currentColor');
    svg.setAttribute('stroke-width','1.7'); svg.setAttribute('stroke-linecap','round'); svg.setAttribute('stroke-linejoin','round');
    const paths=tab.icon.match(/<path\b[^>]*\/>/g)??[];
    for (const markup of paths) {
      const path=document.createElementNS('http://www.w3.org/2000/svg','path');
      const d=markup.match(/d="([^"]+)"/)?.[1]; if(d)path.setAttribute('d',d);
      const transform=markup.match(/transform="([^"]+)"/)?.[1]; if(transform)path.setAttribute('transform',transform);
      svg.append(path);
    }
    svg.setAttribute('aria-hidden','true'); button.prepend(svg); nav.append(button); buttons.set(tab.id,button);
  }

  // Preserve the original form, list and Leaflet nodes so their listeners and drafts survive tab changes.
  mapPane.append(mapPanel);
  addPane.append(capturePanel);
  historyPane.append(historyTabs,statsView,itineraryPanel);
  settingsPane.append(settingsHeading,dataTools);
  panes.append(mapPane,addPane,historyPane,settingsPane);
  shell.append(panes);
  main.append(shell);
  main.after(nav);
  workspace.hidden=true;

  const moveBackupButtons=()=>{
    for (const selector of ['#export-button','#import-backup-button','#mobile-backup-input','#mobile-backup-status']) {
      const control=$(selector);
      if (control && !dataTools.contains(control)) dataTools.append(control);
    }
  };
  moveBackupButtons();
  const backupObserver=new MutationObserver(moveBackupButtons);
  backupObserver.observe(workspace,{childList:true,subtree:true});

  const paneByTab={map:mapPane,add:addPane,history:historyPane,settings:settingsPane};
  let currentTab='map';
  let statsRequest=0;
  let historyMode='stats';
  const selectHistoryMode=mode=>{
    historyMode=mode;
    const showingStats=mode==='stats';
    statsView.hidden=!showingStats; itineraryPanel.hidden=showingStats;
    statsButton.setAttribute('aria-selected',String(showingStats));
    tripsButton.setAttribute('aria-selected',String(!showingStats));
    statsButton.tabIndex=showingStats?0:-1; tripsButton.tabIndex=showingStats?-1:0;
    if(showingStats) void refreshStats();
  };
  historyTabs.append(statsButton,tripsButton);
  statsButton.addEventListener('click',()=>selectHistoryMode('stats'));
  tripsButton.addEventListener('click',()=>selectHistoryMode('trips'));

  async function refreshStats() {
    const request=++statsRequest;
    statsStatus.textContent='正在读取最新行程…';
    refreshButton.disabled=true;
    try {
      const response=await fetch('/api/trips',{headers:{'X-Trip-Local':'1','Cache-Control':'no-cache'},cache:'no-store'});
      if(!response.ok)throw new Error(`无法读取行程（${response.status}）`);
      const payload=await response.json();
      if(request!==statsRequest)return;
      const trips=(Array.isArray(payload.trips)?payload.trips:[]).filter(trip=>trip.type==='flight');
      const routes=rankTrips(trips.filter(trip=>trip.departure&&trip.arrival),trip=>`${trip.departure}|${trip.arrival}`,trip=>`${trip.departure} → ${trip.arrival}`,()=> '航班');
      const airlines=rankTrips(trips,trip=>airlineForFlight(trip.code).code,trip=>airlineForFlight(trip.code).name,trip=>airlineForFlight(trip.code).code);
      for(const entry of airlines)entry.airline=airlineForFlight(entry.meta);
      const aircraft=rankTrips(trips.filter(trip=>trip.aircraftType),trip=>normalizeAircraftType(trip.aircraftType),trip=>normalizeAircraftType(trip.aircraftType),()=> '基础型号');
      renderRanking(routeCard.list,routes,{limit:10});
      renderRanking(airlineCard.list,airlines,{carrier:true});
      renderRanking(aircraftCard.list,aircraft);
      summary.textContent=`${trips.length} 次历史飞行`;
      statsStatus.textContent=trips.length?'统计已更新':'还没有历史航班';
    } catch(error) {
      if(request===statsRequest)statsStatus.textContent=`统计暂时无法读取：${error.message}`;
    } finally {
      if(request===statsRequest)refreshButton.disabled=false;
    }
  }
  refreshButton.addEventListener('click',()=>void refreshStats());

  const refreshMapLayout=()=>{
    requestAnimationFrame(()=>requestAnimationFrame(()=>{
      window.dispatchEvent(new Event('resize'));
      window.dispatchEvent(new Event('xingji:map-visible'));
    }));
  };
  function selectTab(tab, {updateHash=true}={}) {
    if(!paneByTab[tab])tab='map';
    currentTab=tab;
    for(const [id,pane] of Object.entries(paneByTab)) {
      const selected=id===tab;
      pane.hidden=!selected;
      buttons.get(id).setAttribute('aria-selected',String(selected));
      if(selected)buttons.get(id).setAttribute('aria-current','page');
      else buttons.get(id).removeAttribute('aria-current');
    }
    if(updateHash && location.hash!==`#${tab}`)history.replaceState(null,'',`#${tab}`);
    if(tab==='map')refreshMapLayout();
    if(tab==='history'&&historyMode==='stats')void refreshStats();
  }
  for(const [id,button] of buttons)button.addEventListener('click',()=>selectTab(id));
  window.addEventListener('hashchange',()=>selectTab(location.hash.slice(1),{updateHash:false}));
  $('.brand')?.addEventListener('click',event=>{event.preventDefault();selectTab('map');});
  const initialTab=location.hash.slice(1)||document.body.dataset.initialTab||'map';
  selectTab(initialTab,{updateHash:true});

  return {selectTab, getTab:()=>currentTab, refreshStats};
}
