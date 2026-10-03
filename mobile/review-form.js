// Keep the existing draft inputs/listeners: only change their visual grouping.
export function simplifyReviewForm(grid,draft){
  const labels=[...grid.children];
  const fields=new Map(labels.map(label=>[label.querySelector('[name]')?.name,label]));
  const essentials=['code','date'].map(name=>fields.get(name)).filter(Boolean);
  const optional=labels.filter(label=>!essentials.includes(label));
  for(const label of labels){
    const input=label.querySelector('[name]');
    if(input)input.required=['code','date'].includes(input.name);
  }
  const code=fields.get('code')?.querySelector('input');
  if(code){code.placeholder='例如 CA1831';code.autocapitalize='characters';code.spellcheck=false;}
  const details=document.createElement('details');
  details.className='review-optional wide';
  // Do not conceal data extracted from a ticket or already present on an edit.
  details.open=optional.some(label=>String(draft[label.querySelector('[name]')?.name]??'').trim());
  const summary=document.createElement('summary');
  summary.textContent='补充其他信息（选填）';
  const extra=document.createElement('div');extra.className='draft-grid review-optional-grid';
  extra.append(...optional);details.append(summary,extra);
  grid.replaceChildren(...essentials,details);
}

export function requireEssentialDrafts(drafts,root){
  for(const [index,draft] of drafts.entries()){
    const missing=[['code','航班号'],['date','日期']].filter(([name])=>!String(draft[name]??'').trim());
    if(!missing.length)continue;
    const prefix=drafts.length>1?`第 ${index+1} 条行程：`:'';
    window.alert(`${prefix}请填写${missing.map(([,label])=>label).join('和')}。`);
    root.children[index]?.querySelector(`[name="${missing[0][0]}"]`)?.focus();
    return false;
  }
  return true;
}
