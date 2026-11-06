import test from 'node:test';
import assert from 'node:assert/strict';
import {settleSheetGesture, settleSheetKeyboard} from '../bottom-sheet.mjs';

test('sheet gesture changes档位 at displacement threshold and respects direction', () => {
  assert.equal(settleSheetGesture({state:'half',startY:100,endY:59}), 'expanded');
  assert.equal(settleSheetGesture({state:'half',startY:100,endY:60}), 'half');
  assert.equal(settleSheetGesture({state:'expanded',startY:100,endY:141}), 'half');
  assert.equal(settleSheetGesture({state:'expanded',startY:100,endY:140}), 'expanded');
});

test('sheet gesture uses directional velocity and cancel restores current档位', () => {
  assert.equal(settleSheetGesture({state:'half',startY:100,endY:95,velocityY:-0.6}), 'expanded');
  assert.equal(settleSheetGesture({state:'expanded',startY:100,endY:105,velocityY:0.6}), 'half');
  assert.equal(settleSheetGesture({state:'half',startY:100,endY:20,cancelled:true}), 'half');
});

test('sheet slider keyboard maps Arrow keys and Home/End to the two档位', () => {
  assert.equal(settleSheetKeyboard('ArrowUp','half'), 'expanded');
  assert.equal(settleSheetKeyboard('End','half'), 'expanded');
  assert.equal(settleSheetKeyboard('ArrowDown','expanded'), 'half');
  assert.equal(settleSheetKeyboard('Home','expanded'), 'half');
  assert.equal(settleSheetKeyboard('Escape','expanded'), 'expanded');
});
