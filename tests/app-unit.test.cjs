'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const app=require('../shared/experiment-v2.js');

test('formal plan keeps ordered unequal value pairing and requested count',()=>{
  const ratings=[{image_id:1,rating:2},{image_id:2,rating:2},{image_id:3,rating:9}];
  const plan=app.generateCombinations(ratings,150);
  assert.equal(plan.length,150);
  for(const trial of plan){assert.notEqual(trial.rating_1,trial.rating_2);assert.notEqual(trial.images[0],trial.images[1]);}
  assert.deepEqual(app.generateCombinations([{image_id:1,rating:5},{image_id:2,rating:5}],150),[]);
});

test('CSV includes fixed schema after first no-face row and escapes quotes/newlines',()=>{
  const result=app.csv([{valid:false},{gaze_x_raw:.25,detail:'one,"two"\nthree'}],app.GAZE_HEADERS);
  const header=result.split('\r\n')[0];
  assert.ok(header.includes('gaze_x_raw'));assert.ok(header.includes('feature_ly'));assert.ok(header.endsWith(',detail'));
  assert.ok(result.includes('"one,""two""\nthree"'));assert.ok(result.startsWith('\uFEFF'));assert.ok(result.endsWith('\r\n'));
});

test('rectangular AOI requires both axes even when horizontal band matches',()=>{
  const aois=[{x:10,y:20,width:30,height:40},{x:60,y:20,width:30,height:40}];
  assert.deepEqual(app.classify(.2,.9,true,aois,100,100),{roi:'0',horizontal:'1',vertical:'0'});
  assert.equal(app.classify(.2,.4,true,aois,100,100).roi,'1');
  assert.deepEqual(app.classify(null,null,false,aois,100,100),{roi:'UNKNOWN',horizontal:'UNKNOWN',vertical:'UNKNOWN'});
  assert.equal(app.classify(1.3,.4,true,aois,100,100).roi,'0');
});

test('dwell uses real intervals and retains boundary/invalid/gap time as unknown',()=>{
  const sample=(t,roi,valid=true)=>({result_timestamp:t,roi_raw:roi,valid});
  const result=app.dwell([sample(10,'1'),sample(40,'1'),sample(60,'1',false),sample(80,'1'),
    sample(250,'1'),sample(270,'1'),sample(290,'0'),sample(310,'0')],0,400,100);
  assert.equal(result.roi1_ms,50);assert.equal(result.other_ms,20);assert.equal(result.unknown_ms,330);
  assert.equal(result.roi1_ms+result.roi2_ms+result.other_ms+result.unknown_ms,400);
});

test('dwell never extrapolates a last sample or joins records outside the trial',()=>{
  const rows=[{result_timestamp:-20,roi_raw:'1',valid:true},{result_timestamp:20,roi_raw:'1',valid:true},
    {result_timestamp:150,roi_raw:'1',valid:true}];
  const result=app.dwell(rows,0,100,100);
  assert.equal(result.roi1_ms,0);assert.equal(result.unknown_ms,100);
  assert.equal(app.dwell([],0,250).max_gap_ms,250);
});

test('corrupt nonmonotonic timestamps cannot make summed dwell exceed RT',()=>{
  const result=app.dwell([50,90,55,95].map(t=>({result_timestamp:t,roi_raw:'1',valid:true})),0,100);
  assert.equal(result.unknown_ms,100);assert.equal(result.coverage,0);
});

test('causal smoothing resets after a gap and does not clip offscreen predictions',()=>{
  const first=app.smooth(null,{x:1.25,y:-.1},100);
  assert.equal(first.x,1.25);assert.equal(first.y,-.1);
  const next=app.smooth(first,{x:.25,y:.5},120);
  assert.ok(next.x>.25&&next.x<1.25);
  const afterGap=app.smooth(next,{x:.1,y:.2},400);
  assert.equal(afterGap.x,.1);assert.equal(afterGap.y,.2);
});

test('validation coordinate pairs are all held out from the fitting targets',()=>{
  assert.equal(app.CALIBRATION_TARGETS.length,9);assert.equal(app.VALIDATION_TARGETS.length,9);
  const pairs=new Set(app.CALIBRATION_TARGETS.map(t=>`${t.targetX},${t.targetY}`));
  for(const target of app.VALIDATION_TARGETS)assert.ok(!pairs.has(`${target.targetX},${target.targetY}`));
  assert.equal(app.CONFIG.layoutVersion,'pixel-aligned-square-aoi-v2.0.2');
});
