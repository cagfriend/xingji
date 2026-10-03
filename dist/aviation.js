const carriers=Object.freeze({
  CA:{name:'中国国际航空',color:'#c7272d',logo:'/airlines/CA.svg'}, MU:{name:'中国东方航空',color:'#d51920',logo:'/airlines/MU.png'},
  SC:{name:'山东航空',color:'#c72c32',logo:'/airlines/SC.png'}, CX:{name:'国泰航空',color:'#006564',logo:'/airlines/CX.svg'},
  CZ:{name:'中国南方航空',color:'#1594c8',logo:'/airlines/CZ.svg'}, OZ:{name:'韩亚航空',color:'#b21f35',logo:'/airlines/OZ.svg'},
  HU:{name:'海南航空',color:'#ba942e',logo:'/airlines/HU.png'}, MF:{name:'厦门航空',color:'#008cd5',logo:'/airlines/MF.png'},
  ZH:{name:'深圳航空',color:'#a6192e',logo:'/airlines/ZH.png'}, DZ:{name:'东海航空',color:'#2066b1',logo:'/airlines/DZ.png'}, EU:{name:'成都航空',color:'#c1252a'},
  GS:{name:'天津航空',color:'#9c1830',logo:'/airlines/GS.png'}, HO:{name:'吉祥航空',color:'#b22642',logo:'/airlines/HO.png'}, KN:{name:'中国联合航空',color:'#294d9b',logo:'/airlines/KN.png'},
  '9C':{name:'春秋航空',color:'#58a61e',logo:'/airlines/9C.png'},'8L':{name:'祥鹏航空',color:'#d8242f',logo:'/airlines/8L.png'},PN:{name:'西部航空',color:'#d3272d',logo:'/airlines/PN.png'},AQ:{name:'九元航空',color:'#ec7b15',logo:'/airlines/AQ.png'},BK:{name:'奥凯航空',color:'#317bc1',logo:'/airlines/BK.png'},
  HX:{name:'香港航空',color:'#bd1e2d',logo:'/airlines/HX.png'},UO:{name:'香港快运航空',color:'#7b3690',logo:'/airlines/UO.png'},NX:{name:'澳门航空',color:'#177b43',logo:'/airlines/NX.png'},
  BR:{name:'长荣航空',color:'#1b714a',logo:'/airlines/BR.png'},CI:{name:'中华航空',color:'#e14b65',logo:'/airlines/CI.png'},JX:{name:'星宇航空',color:'#8a6a40',logo:'/airlines/JX.png'},AE:{name:'华信航空',color:'#bf1f3c',logo:'/airlines/AE.png'},
  JL:{name:'日本航空',color:'#c9202f',logo:'/airlines/JL.png'},NH:{name:'全日空',color:'#0758a5',logo:'/airlines/NH.png'},MM:{name:'乐桃航空',color:'#9e328c',logo:'/airlines/MM.png'},GK:{name:'捷星日本航空',color:'#f26322',logo:'/airlines/GK.png'},BC:{name:'天马航空',color:'#0074bf',logo:'/airlines/BC.png'},
  KE:{name:'大韩航空',color:'#2c60a8',logo:'/airlines/KE.png'},'7C':{name:'济州航空',color:'#f47521',logo:'/airlines/7C.png'},LJ:{name:'真航空',color:'#73439b',logo:'/airlines/LJ.png'},BX:{name:'釜山航空',color:'#0078c8',logo:'/airlines/BX.png'},TW:{name:'德威航空',color:'#c61b35',logo:'/airlines/TW.png'},ZE:{name:'易斯达航空',color:'#c5262d',logo:'/airlines/ZE.png'},RS:{name:'首尔航空',color:'#5ba842',logo:'/airlines/RS.png'}
});

export function airlineForFlight(flightCode){
  const code=String(flightCode??'').normalize('NFKC').trim().toUpperCase().match(/^[A-Z0-9]{2}/)?.[0]??'';
  return carriers[code]?{code,...carriers[code]}:{code,name:code?`${code} 航空`:'航司待补充',color:'#60708a',logo:''};
}

export function normalizeAircraftType(value){
  const raw=String(value??'').normalize('NFKC').trim();
  if(!raw)return '';
  const compact=raw.toUpperCase().replace(/[\s_]/g,'');
  if(/(?:中国商飞|COMAC)?C919/.test(compact))return '中国商飞 C919';
  if(/(?:中国商飞|COMAC)?(?:C909|ARJ21)/.test(compact))return '中国商飞 C909';
  if(/(?:ERJ|E-?)190/.test(compact))return '巴航工业 E190';
  if(/(?:空客|AIRBUS|A)320/.test(compact))return '空客 A320';
  if(/(?:空客|AIRBUS|A)321/.test(compact))return '空客 A321';
  if(/(?:空客|AIRBUS|A)330/.test(compact)){
    if(/-2\d{2}\b/.test(compact)||/-200\b/.test(compact))return '空客 A330-200';
    if(/-3\d{2}\b/.test(compact)||/-300\b/.test(compact))return '空客 A330-300';
    return '空客 A330';
  }
  if(/(?:空客|AIRBUS|A)350/.test(compact)){
    if(/-9\d{2}\b/.test(compact)||/-900\b/.test(compact))return '空客 A350-900';
    if(/-10\d{2}\b/.test(compact)||/-1000\b/.test(compact))return '空客 A350-1000';
    return '空客 A350';
  }
  if(/(?:波音|BOEING|B|^)737/.test(compact)){
    if(/MAX8/.test(compact))return '波音 737 MAX 8';
    if(/737-?8(?:00|[A-Z0-9]{1,3})\b/.test(compact))return '波音 737-800';
    if(/737-?7(?:00|[A-Z0-9]{1,3})\b/.test(compact))return '波音 737-700';
    if(/737-?9(?:00|[A-Z0-9]{1,3})\b/.test(compact))return '波音 737-900';
    return '波音 737';
  }
  if(/(?:波音|BOEING|B)777/.test(compact)){
    if(/ER/.test(compact))return '波音 777-200ER';
    if(/-2\d{2}\b/.test(compact)||/-200\b/.test(compact))return '波音 777-200';
    if(/-3\d{2}\b/.test(compact)||/-300\b/.test(compact))return '波音 777-300';
    return '波音 777';
  }
  return raw.replace(/\s+/g,' ');
}
