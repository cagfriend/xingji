import test from 'node:test';
import assert from 'node:assert/strict';
import {requireEssentialDrafts} from '../review-form.js';
test('missing essentials are reminded only on a save attempt',()=>{
  const original=globalThis.window;const alerts=[];const focused=[];
  globalThis.window={alert:message=>alerts.push(message)};
  const root={children:[{querySelector:selector=>({focus:()=>focused.push(selector)})}]};
  try{
    assert.equal(requireEssentialDrafts([{code:'',date:''}],root),false);
    assert.equal(alerts.at(-1),'请填写航班号和日期。');
    assert.equal(requireEssentialDrafts([{code:'CA1831',date:''}],root),false);
    assert.equal(alerts.at(-1),'请填写日期。');
    assert.equal(requireEssentialDrafts([{code:'  ',date:'2026-10-12'}],root),false);
    assert.equal(alerts.at(-1),'请填写航班号。');
    assert.equal(requireEssentialDrafts([{code:'CA1831',date:'2026-10-12',departure:'',arrival:''}],root),true);
    assert.equal(alerts.length,3,'optional fields never trigger a missing-field reminder');
    assert.deepEqual(focused,['[name="code"]','[name="date"]','[name="code"]']);
  }finally{if(original===undefined)delete globalThis.window;else globalThis.window=original;}
});
