export function prepareSheetLayouts(root=document){
  for(const dialog of root.querySelectorAll('#trip-detail-dialog,#map-group-dialog,#map-airport-dialog')){
    if(dialog.querySelector('.sheet-content'))continue;
    const content=document.createElement('div');content.className='sheet-content';
    for(const child of [...dialog.children])if(!child.classList.contains('dialog-header')&&!child.classList.contains('sheet-drag-handle'))content.append(child);
    dialog.append(content);
  }
}
