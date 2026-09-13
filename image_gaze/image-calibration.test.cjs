'use strict';
// Independent analytic checks of the dual-ridge scale and train-only CV transform.
const test=require('node:test');
const assert=require('node:assert/strict');
const C=require('./image-calibration.js');
const grid=[.08,.5,.92].flatMap((y,row)=>[.08,.5,.92].map((x,col)=>({targetId:`c${row*3+col+1}`,targetX:x,targetY:y})));
const output=(x,y)=>[x,y,...Array(256).fill(0)];
function presentations(transform=(x,y)=>[x,y]){
  return [1,2].flatMap(roundIndex=>grid.map((point,index)=>({kind:'calibration',...point,roundIndex,presentationId:`r${roundIndex}-${point.targetId}`,
    attempts:Array.from({length:12},(_,i)=>({valid:true,timestamp:roundIndex*10000+index*300+i*20,output:output(...transform(point.targetX,point.targetY,roundIndex))}))})));
}

test('dual normalized linear kernel matches the independent closed-form 2D ridge solution',()=>{
  const lambda=.1,reps=presentations().map(p=>({...p,output:p.attempts[0].output}));
  const model=C.fitRepresentatives(reps,{id:'analytic',representation:'network_xy',lambda});
  // Balanced 3×3 grid: Z'Z=nI. Since K=ZZ'/2, each centered
  // coordinate has shrinkage 1/(1+2*lambda), with unpenalized .5 intercept.
  for(const [x,y] of [[.08,.92],[.31,.44],[.5,.5],[1.2,-.3]]){
    const actual=C.predict(model,output(x,y));
    assert.equal(actual.valid,true);
    assert.ok(Math.abs(actual.x-(.5+(x-.5)/(1+2*lambda)))<1e-12);
    assert.ok(Math.abs(actual.y-(.5+(y-.5)/(1+2*lambda)))<1e-12);
  }
});

test('round-held-out scores use only the training round mean and scale',()=>{
  const data=presentations((x,y,round)=>round===1?[x,y]:[10*x+3,10*y-4]);
  const actual=C.fitCalibration(data);assert.equal(actual.ok,true);
  const candidate=actual.candidates.find(c=>c.id==='network_xy_ridge_0.01');assert.equal(candidate.ok,true);
  for(const fold of candidate.folds){
    const errors=grid.map(({targetX:x,targetY:y})=>{
      const px=fold.trainRound===1?.5+(10*x+3-.5)/1.02:.5+(x-8)/10/1.02;
      const py=fold.trainRound===1?.5+(10*y-4-.5)/1.02:.5+(y-1)/10/1.02;
      return Math.hypot(px-x,py-y);
    });
    const expected=errors.reduce((sum,v)=>sum+v,0)/errors.length;
    assert.ok(Math.abs(fold.score-expected)<1e-11,`train ${fold.trainRound}: ${fold.score} vs ${expected}`);
  }
});

test('256-dimensional embedding normalization gives the independently equivalent 2D kernel and excludes raw XY',()=>{
  const embedding=(x,y)=>[999,-999,...Array.from({length:256},(_,j)=>(j+1)*(j%2?y:x)+j)];
  const reps=presentations().map(p=>({...p,output:embedding(p.targetX,p.targetY)}));
  const model=C.fitRepresentatives(reps,{id:'analytic-embedding',representation:'embedding',lambda:.1});
  assert.equal(model.active.length,256);
  const actual=C.predict(model,embedding(.3,.7));
  assert.ok(Math.abs(actual.x-(.5+(.3-.5)/1.2))<1e-12);
  assert.ok(Math.abs(actual.y-(.5+(.7-.5)/1.2))<1e-12);
});

test('adding more identical frames at one calibration position cannot change presentation weighting or CV weighting',()=>{
  const data=presentations(),first=C.fitCalibration(data);assert.equal(first.ok,true);
  const more=structuredClone(data),last=more.at(-1),sample=last.attempts[0];
  for(let i=12;i<112;i++)last.attempts.push({...sample,timestamp:sample.timestamp+i*20,output:sample.output.slice()});
  const second=C.fitCalibration(more);assert.equal(second.ok,true);
  assert.deepEqual(second.model,first.model);
  assert.equal(second.selectedCandidateId,first.selectedCandidateId);
  for(let i=0;i<second.candidates.length;i++)if(second.candidates[i].ok)assert.ok(Math.abs(second.candidates[i].score-first.candidates[i].score)<1e-12);
});

test('validation identities and mixed-dimensional network outputs cannot silently enter calibration',()=>{
  const data=presentations();data[0].kind='validation';
  assert.equal(C.fitCalibration(data).ok,false);
  const mixed=presentations();mixed[0].attempts[0].output.pop();
  assert.equal(C.fitCalibration(mixed).ok,false);
  const duplicate=presentations();duplicate[1].targetId=duplicate[0].targetId;
  assert.equal(C.fitCalibration(duplicate).ok,false);
});

test('fitting and prediction leave source observations unchanged and do not retain their mutable arrays',()=>{
  const data=presentations();const saved=JSON.stringify(data),fit=C.fitCalibration(data);
  assert.equal(fit.ok,true);assert.equal(JSON.stringify(data),saved);
  const before=C.predict(fit.model,output(.3,.6));data[0].attempts[0].output.fill(100);
  assert.deepEqual(C.predict(fit.model,output(.3,.6)),before);
  const old=JSON.stringify(fit.model);C.predict(fit.model,output(-1,2));assert.equal(JSON.stringify(fit.model),old);
});

test('the fixed MGazeNet contract rejects consistently truncated, expanded or nonfinite outputs',()=>{
  assert.equal(C.OUTPUT_LENGTH,258);
  for(const length of [4,257,259,1024]){
    const data=presentations();for(const p of data)for(const a of p.attempts)a.output=Array.from({length},(_,i)=>a.output[i]??0);
    const fit=C.fitCalibration(data);assert.equal(fit.ok,false);assert.equal(fit.reason,'expected_258_network_outputs');
  }
  const nonfinite=presentations();nonfinite[0].attempts[0].output[150]=Infinity;
  assert.equal(C.fitCalibration(nonfinite).ok,false);
  const allConstant=presentations(()=>[.5,.5]);assert.equal(C.fitCalibration(allConstant).reason,'no_eligible_calibration_model');
});

test('attempt provenance blocks relabelled validation frames, wrong targets/rounds and duplicate sample IDs',()=>{
  for(const mismatch of [{phase:'validation'},{kind:'validation'},{targetId:'v1'},{presentationId:'r2-c1'},{roundIndex:2},{targetX:.3}]){
    const data=presentations();Object.assign(data[0].attempts[0],mismatch);
    assert.equal(C.fitCalibration(data).reason,'inconsistent_sample_identity');
  }
  const duplicate=presentations();duplicate[0].attempts[0].sampleId=1;duplicate[1].attempts[0].sampleId=1;
  assert.equal(C.fitCalibration(duplicate).reason,'duplicate_sample_id');
});

test('timestamps and supplied acquisition windows are checked for every logged attempt, including rejected frames',()=>{
  const data=presentations();
  for(const p of data){p.collectStart=p.attempts[0].timestamp-5;p.collectEnd=p.attempts.at(-1).timestamp+5;for(const a of p.attempts)a.capturedAt=a.timestamp-2;}
  assert.equal(C.fitCalibration(data).ok,true);
  for(const mutate of [
    p=>{p.attempts[0].capturedAt=p.collectStart-1;},
    p=>{p.attempts.at(-1).timestamp=p.collectEnd+1;},
    p=>{p.attempts[0].capturedAt=p.attempts[0].timestamp+1;},
    p=>{p.attempts[1].timestamp=p.attempts[0].timestamp;},
    p=>{p.attempts.push({valid:false,timestamp:p.attempts[0].timestamp,output:null});}
  ]){
    const bad=structuredClone(data);mutate(bad[0]);assert.equal(C.fitCalibration(bad).ok,false);
  }
});

test('captured-in-window late completions stay in the denominator as invalid and cannot enter fitting',()=>{
  const data=presentations();
  for(const p of data){p.collectStart=p.attempts[0].timestamp-5;p.collectEnd=p.attempts.at(-1).timestamp+5;for(const a of p.attempts){a.capturedAt=a.timestamp;a.completedAt=a.timestamp+1;}}
  const original=C.fitCalibration(data);assert.equal(original.ok,true);
  const p=data[0],late={valid:false,reason:'completed_after_collection_window',timestamp:p.collectEnd-1,capturedAt:p.collectEnd-1,completedAt:p.collectEnd+60,output:null};
  p.attempts.push(late);
  const withLate=C.fitCalibration(data);assert.equal(withLate.ok,true);assert.deepEqual(withLate.model,original.model);
  assert.equal(data[0].attempts.length,13);assert.equal(withLate.representatives[0].sampleCount,12);
  late.valid=true;late.output=output(.08,.08);
  assert.equal(C.fitCalibration(data).reason,'sample_outside_calibration_window');
  late.valid=false;late.capturedAt=p.collectEnd+1;late.timestamp=late.capturedAt;
  assert.equal(C.fitCalibration(data).reason,'sample_outside_calibration_window');
});

test('missing or degenerate rounds and malformed models fail closed without throwing in predict',()=>{
  const missing=presentations().slice(1);assert.equal(C.fitCalibration(missing).ok,false);
  const collinear=presentations();for(const p of collinear){const value=.08+(Number(p.targetId.slice(1))-1)*.105;p.targetX=value;p.targetY=value;}
  assert.equal(C.fitCalibration(collinear).reason,'degenerate_calibration_grid');
  assert.equal(C.fitCalibration(presentations(),null).reason,'invalid_calibration_options');
  assert.equal(C.fitCalibration([null,...presentations().slice(1)]).reason,'invalid_calibration_identity');
  const model=C.fitCalibration(presentations()).model;
  for(const broken of [null,{}, {...model,outputLength:4},{...model,representation:'unknown'}, {...model,anchors:null},
    {...model,active:[0,0]},{...model,scale:[0,0]},{...model,alphaX:[NaN]}, {...model,mean:[]}]){
    assert.deepEqual(C.predict(broken,output(.5,.5)),{valid:false,x:null,y:null,reason:'invalid_model_input'});
  }
  assert.throws(()=>C.solveSPD([[1,2],[0,1]],[1,1]),/invalid_linear_system/);
  assert.throws(()=>C.solveSPD([[1,2],[2,1]],[1,1]),/ill_conditioned_model/);
});
