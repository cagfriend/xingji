// Rebuild bundled, offline-only map catalog from documented public data.
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const project = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const output = path.join(project,'dist','map-data');
await mkdir(output,{recursive:true});
async function text(url) {const r=await fetch(url);if(!r.ok)throw new Error(`${r.status} ${url}`);return r.text();}
async function githubContent(name) {
  const value=await json(`https://api.github.com/repos/Timeon1/TMC_Dataset/contents/${name}`);
  if(!value.content)throw new Error(`GitHub content missing: ${name}`);
  return JSON.parse(Buffer.from(value.content,'base64').toString('utf8'));
}
function parseCSV(value){const rows=[];let row=[],field='',quoted=false;for(let i=0;i<value.length;i++){const c=value[i];if(c==='"'){if(quoted&&value[i+1]==='"'){field+='"';i++;}else quoted=!quoted;}else if(c===','&&!quoted){row.push(field);field='';}else if((c==='\n'||c==='\r')&&!quoted){if(c==='\r'&&value[i+1]==='\n')i++;row.push(field);if(row.length>1)rows.push(row);row=[];field='';}else field+=c;}if(field||row.length){row.push(field);rows.push(row);}return rows;}
function normalize(value){return String(value??'').normalize('NFKC').trim().toLowerCase().replace(/[\s·•（）()\-_,，]/g,'').replace(/国际机场$|机场$/,'');}
const airportCSV=await text('https://cdn.jsdelivr.net/gh/davidmegginson/ourairports-data@main/airports.csv');
const rows=parseCSV(airportCSV);const headers=rows.shift();const col=Object.fromEntries(headers.map((name,i)=>[name,i]));
const airports=[];const byIata=new Map();
for(const row of rows){const iata=row[col.iata_code]?.trim().toUpperCase();const lat=Number(row[col.latitude_deg]);const lon=Number(row[col.longitude_deg]);if(!iata||!/^[A-Z]{3}$/.test(iata)||!Number.isFinite(lat)||!Number.isFinite(lon)||row[col.type]==='closed')continue;const item={id:`air:${row[col.ident]}`,iata,name:row[col.name],city:row[col.municipality]||'',lat,lon,aliases:[iata,row[col.ident],row[col.name]]};airports.push(item);if(!byIata.has(iata))byIata.set(iata,[]);byIata.get(iata).push(item);}
const terminalData=await githubContent('airport-terminal-cn.json');
function descend(value){if(Array.isArray(value)){for(const entry of value)descend(entry);}else if(value&&typeof value==='object'){if(value.AirportName&&value.AirportCode){const candidates=byIata.get(String(value.AirportCode).toUpperCase())||[];const selected=candidates.find(x=>x.id.slice(4)===value.AirportCode)||candidates.find(x=>x.city)||candidates[0];if(selected){const airport=String(value.AirportName);const city=String(value.CityName||'');const structuredName=city&& !airport.startsWith(city)?city+airport:airport;selected.aliases.push(airport,city+airport,airport.replace(/国际机场$|机场$/,''),city+airport.replace(/国际机场$|机场$/,''));if(!selected.structuredName)selected.structuredName=structuredName;}}for(const inner of Object.values(value))if(inner&&typeof inner==='object')descend(inner);}}
descend(terminalData);
// Common ticket-style names that identify a specific airport rather than a city.
// They are lookup aliases only; codes and coordinates remain from OurAirports.
const ticketAliases={
  ICN:['仁川','仁川国际机场','首尔仁川','首尔/仁川','首尔仁川国际机场'],
  SHE:['沈阳','沈阳桃仙','沈阳桃仙国际机场']
};
for(const airport of airports)for(const alias of ticketAliases[airport.iata]??[])airport.aliases.push(alias);
const airportOutput=airports.map(({id,iata,name,city,lat,lon,aliases,structuredName})=>({id,iata,name,city,lat,lon,structuredName:structuredName||'',aliases:[...new Set(aliases.map(normalize).filter(Boolean))]}));
await writeFile(path.join(output,'places.json'),JSON.stringify({airports:airportOutput}), 'utf8');
console.log(JSON.stringify({airports:airportOutput.length,airportAliasChecks:['沈阳桃仙','武汉天河','大连周水子'].map(n=>[n,airportOutput.filter(a=>a.aliases.includes(normalize(n))).map(a=>a.iata)])}));
