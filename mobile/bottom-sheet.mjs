const DIALOGS = '#trip-detail-dialog,#map-group-dialog,#map-airport-dialog';
const HALF = 'half';
const EXPANDED = 'expanded';
const SWIPE_DISTANCE = 40;
const SWIPE_SPEED = 0.5;

export function settleSheetGesture({ state = HALF, startY, endY, velocityY = 0, cancelled = false } = {}) {
  if (cancelled || !Number.isFinite(startY) || !Number.isFinite(endY)) return state;
  const delta = endY - startY;
  if (delta < -SWIPE_DISTANCE || velocityY <= -SWIPE_SPEED) return EXPANDED;
  if (delta > SWIPE_DISTANCE || velocityY >= SWIPE_SPEED) return HALF;
  return state;
}

export function settleSheetKeyboard(key, state = HALF) {
  if (key === 'ArrowUp' || key === 'End') return EXPANDED;
  if (key === 'ArrowDown' || key === 'Home') return HALF;
  return state;
}

function resetScroll(dialog) {
  dialog.scrollTop = 0;
  const content = dialog.querySelector('.sheet-content');
  if (content) content.scrollTop = 0;
}

function setState(dialog, handle, state) {
  dialog.dataset.sheetState = state;
  handle.setAttribute('aria-valuenow', state === EXPANDED ? '75' : '50');
  dialog.style.removeProperty('--sheet-drag-height');
}

export function installBottomSheets({ root = document } = {}) {
  const cleanups = [];
  const observers = [];
  for (const dialog of root.querySelectorAll(DIALOGS)) {
    dialog.classList.add('mobile-bottom-sheet');
    let handle = dialog.querySelector('.sheet-drag-handle');
    if (!handle) {
      handle = dialog.ownerDocument.createElement('div');
      handle.className = 'sheet-drag-handle';
      const slider = dialog.ownerDocument.createElement('span');
      slider.setAttribute('aria-hidden', 'true');
      handle.append(slider);
      const header = dialog.querySelector('.dialog-header');
      dialog.insertBefore(handle, header || dialog.firstChild);
    }
    handle.tabIndex = 0;
    handle.setAttribute('role', 'slider');
    handle.setAttribute('aria-label', '调整信息框高度');
    handle.setAttribute('aria-valuemin', '50');
    handle.setAttribute('aria-valuemax', '75');
    handle.querySelector('span')?.setAttribute('aria-hidden', 'true');
    setState(dialog, handle, dialog.dataset.sheetState || HALF);

    const onKeyDown = event => {
      const next = settleSheetKeyboard(event.key, dialog.dataset.sheetState || HALF);
      if (next !== (dialog.dataset.sheetState || HALF)) {
        event.preventDefault();
        setState(dialog, handle, next);
      }
    };
    handle.addEventListener('keydown', onKeyDown);

    let drag = null;
    const onDown = event => {
      if (event.isPrimary === false || (event.button !== undefined && event.button !== 0)) return;
      drag = { id: event.pointerId, startY: event.clientY, lastY: event.clientY, lastTime: event.timeStamp, startTime: event.timeStamp, state: dialog.dataset.sheetState || HALF };
      try { handle.setPointerCapture(event.pointerId); } catch {}
    };
    const onMove = event => {
      if (!drag || event.pointerId !== drag.id) return;
      drag.lastY = event.clientY;
      drag.lastTime = event.timeStamp;
      const delta = drag.startY - event.clientY;
      const max = (dialog.ownerDocument.defaultView?.innerHeight || 0) * 0.25;
      const clamped = drag.state === EXPANDED ? Math.max(-max, Math.min(0, delta)) : Math.max(0, Math.min(max, delta));
      dialog.style.setProperty('--sheet-drag-height', `calc(${drag.state === EXPANDED ? '75dvh' : '50dvh'} + ${clamped}px)`);
    };
    const finish = (event, cancelled) => {
      if (!drag || (event.pointerId !== undefined && event.pointerId !== drag.id)) return;
      const current = drag;
      drag = null;
      const elapsed = Math.max(1, (event.timeStamp ?? current.lastTime) - current.startTime);
      const velocityY = ((event.clientY ?? current.lastY) - current.startY) / elapsed;
      setState(dialog, handle, settleSheetGesture({ state: current.state, startY: current.startY, endY: event.clientY ?? current.lastY, velocityY, cancelled }));
      try { if (handle.hasPointerCapture(current.id)) handle.releasePointerCapture(current.id); } catch {}
    };
    const onUp = event => finish(event, false);
    const onCancel = event => finish(event, true);
    const onLostCapture = event => finish(event, true);
    handle.addEventListener('pointerdown', onDown);
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onCancel);
    handle.addEventListener('lostpointercapture', onLostCapture);
    cleanups.push(() => {
      handle.removeEventListener('keydown', onKeyDown);
      handle.removeEventListener('pointerdown', onDown);
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onCancel);
      handle.removeEventListener('lostpointercapture', onLostCapture);
    });

    const Observer = dialog.ownerDocument.defaultView?.MutationObserver || globalThis.MutationObserver;
    if (Observer) {
      let wasOpen = dialog.open;
      const observer = new Observer(() => {
        const isOpen = dialog.open;
        if (isOpen && !wasOpen) {
          setState(dialog, handle, HALF);
          resetScroll(dialog);
        }
        wasOpen = isOpen;
      });
      observer.observe(dialog, { attributes: true, attributeFilter: ['open'] });
      observers.push(observer);
    }
    if (dialog.open) resetScroll(dialog);
  }
  return () => {
    for (const cleanup of cleanups) cleanup();
    for (const observer of observers) observer.disconnect();
  };
}
