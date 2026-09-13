'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const zlib = require('node:zlib');
const P = require('./preprocess.js');
function source(width, height, pixel) {
  const rgba = new Uint8Array(width * height * 4);
  for (let y=0;y<height;y++) for (let x=0;x<width;x++) rgba.set([...pixel(x,y), 255], (y*width+x)*4);
  return { rgba, width, height };
}
const rect=(x,y,width,height)=>({x,y,width,height});
function mirror(image) {
  return source(image.width,image.height,(x,y)=>Array.from(image.rgba.slice((y*image.width+image.width-1-x)*4,(y*image.width+image.width-1-x)*4+3)));
}

test('crop samples source-image pixels, preserves RGB channel order and ignores alpha',()=>{
  const input=source(4,3,(x,y)=>[x*10,y*20,5+x+y]);
  for(let i=3;i<input.rgba.length;i+=4)input.rgba[i]=17;
  const actual=P.resizeRgbCrop(input,rect(1,1,2,2),2,2);
  assert.deepEqual(Array.from(actual),[10,20,7,20,20,8,10,40,8,20,40,9]);
});

test('half-pixel bilinear interpolation has hand-computed center and edge values',()=>{
  const input=source(2,2,(x,y)=>[x*100+y*40,0,255]);
  const out=P.resizeRgbCrop(input,rect(0,0,2,2),3,3);
  assert.deepEqual(Array.from(out).filter((_,i)=>i%3===0),[0,50,100,20,70,120,40,90,140]);
  assert.deepEqual(Array.from(out).filter((_,i)=>i%3===2),Array(9).fill(255));
  const down=P.resizeRgbCrop(input,rect(0,0,2,2),1,1);
  assert.deepEqual(Array.from(down),[70,0,255]);
  const rounding=source(2,1,x=>[x,0,0]);
  assert.equal(P.resizeRgbCrop(rounding,rect(0,0,2,1),1,1)[0],1);
});

test('one-pixel crops repeat exactly and horizontal output flip is applied after resizing',()=>{
  const input=source(3,1,x=>[x*100,10,20]);
  const single=P.resizeRgbCrop(input,rect(1,0,1,1),2,2);
  assert.deepEqual(Array.from(single),[100,10,20,100,10,20,100,10,20,100,10,20]);
  const normal=P.resizeRgbCrop(input,rect(0,0,3,1),4,1);
  const flipped=P.resizeRgbCrop(input,rect(0,0,3,1),4,1,true);
  for(let x=0;x<4;x++)assert.deepEqual(flipped.slice(x*3,x*3+3),normal.slice((3-x)*3,(4-x)*3));
});

test('named model inputs have NHWC shapes, RGB float32 values, right-eye flip and width-height-x-y rectangles',()=>{
  const input=source(8,6,(x,y)=>[x*30,y*40,255]);
  const opts={...input,face:rect(1,1,6,4),leftEye:rect(1,2,2,1),rightEye:rect(5,2,2,1)};
  const got=P.prepareInputs(opts);
  assert.deepEqual(got.face.shape,[1,224,224,3]);assert.deepEqual(got.left.shape,[1,112,112,3]);assert.deepEqual(got.right.shape,[1,112,112,3]);assert.deepEqual(got.rect.shape,[1,12]);
  assert.equal(got.face.data.length,224*224*3);assert.equal(got.left.data.length,112*112*3);
  assert.deepEqual(got.face.data.slice(0,3),new Float32Array([30/255,40/255,1]));
  assert.equal(got.left.data[0],Math.fround(30/255));
  assert.equal(got.right.data[0],Math.fround(180/255));
  assert.equal(got.right.data[(112-1)*3],Math.fround(150/255));
  assert.deepEqual(got.rect.data,new Float32Array([6/8,4/6,1/8,1/6,2/8,1/6,1/8,2/6,2/8,1/6,5/8,2/6]));
  assert.equal(got.metadata.inferencePerformed,false);assert.equal(got.metadata.sourceImage.width,8);
});

test('physically mirrored pixels plus reflected source rectangles restore the exact canonical model inputs',()=>{
  const input=source(8,6,(x,y)=>[x*30,y*40,(x+y)*15]);
  const opts={...input,face:rect(0,1,6,4),leftEye:rect(1,2,2,1),rightEye:rect(5,2,2,1)};
  const mirrored={...mirror(input),sourceMirrored:true};
  for(const key of ['face','leftEye','rightEye'])mirrored[key]={...opts[key],x:input.width-opts[key].x-opts[key].width};
  const direct=P.prepareInputs(opts),restored=P.prepareInputs(mirrored);
  for(const key of ['face','left','right','rect'])assert.deepEqual(restored[key],direct[key]);
  assert.equal(restored.metadata.sourceImage.sourceMirrored,true);
  assert.deepEqual(restored.metadata.canonicalRectangles,direct.metadata.canonicalRectangles);
});

test('invalid source dimensions, packed format and any empty/fractional/out-of-bounds rectangle fail explicitly',()=>{
  const input=source(8,6,()=>[1,2,3]),good=rect(0,0,2,2);
  for(const bad of [rect(-1,0,2,2),rect(0,-1,2,2),rect(7,0,2,2),rect(0,5,2,2),rect(0,0,0,2),rect(.5,0,2,2),rect(0,0,Infinity,2)]){
    assert.throws(()=>P.prepareInputs({...input,face:good,leftEye:good,rightEye:bad}),RangeError);
  }
  assert.throws(()=>P.prepareInputs({...input,width:7,face:good,leftEye:good,rightEye:good}),RangeError);
  assert.throws(()=>P.resizeRgbCrop({...input,rgba:Array.from(input.rgba)},good,2,2),TypeError);
  assert.throws(()=>P.resizeRgbCrop({...input,sourceMirrored:'false'},good,2,2),TypeError);
  assert.throws(()=>P.resizeRgbCrop(input,good,0,2),RangeError);
});

test('preprocessing does not mutate inputs or alias output tensors; browser UMD works without a DOM',()=>{
  const input=source(4,4,(x,y)=>[x,y,77]),r=rect(0,0,4,4),original=input.rgba.slice();
  const opts={...input,face:r,leftEye:r,rightEye:r};
  const got=P.prepareInputs(opts);assert.deepEqual(input.rgba,original);assert.deepEqual(r,rect(0,0,4,4));
  input.rgba.fill(0);r.x=100;assert.equal(got.face.data[2],Math.fround(77/255));assert.equal(got.metadata.canonicalRectangles.face.x,0);
  got.left.data.fill(0);assert.equal(got.right.data[2],Math.fround(77/255));
  const context=vm.createContext({});vm.runInContext(fs.readFileSync(require.resolve('./preprocess.js'),'utf8'),context);
  assert.equal(typeof context.MGazePreprocess.prepareInputs,'function');assert.equal(context.MGazePreprocess.contract.id,P.contract.id);
});

test('landmark-derived rectangles match pinned upstream Python code, including ties-to-even and strict eye edges',()=>{
  const oracle=JSON.parse(fs.readFileSync(require.resolve('./preprocess-oracle.json'),'utf8'));
  assert.equal(oracle.upstreamCommit,P.contract.upstreamCommit);
  for(const example of oracle.roiCases){
    const points=Array.from({length:478},(_,i)=>({...example.defaultPoint,...example.overrides[String(i)]}));
    const before=JSON.stringify(points);
    const actual=P.roisFromLandmarks(points,example.width,example.height);
    assert.equal(actual.ok,example.expected.ok,example.name);
    if(actual.ok){
      for(const key of ['face','leftEye','rightEye'])assert.deepEqual(actual[key],example.expected[key],`${example.name} ${key}`);
      assert.equal(actual.diagnostics.leftEyeOpenness,example.expected.leftEyeOpenness);
      assert.equal(actual.diagnostics.rightEyeOpenness,example.expected.rightEyeOpenness);
    }
    assert.equal(JSON.stringify(points),before,'Landmarks must remain normalized and unmodified');
  }
});

test('invalid landmarks, int16 overflow and empty ROIs fail closed',()=>{
  const base=Array.from({length:478},()=>({x:.5,y:.5,z:0}));
  assert.equal(P.roisFromLandmarks(base,640,480).reason,'invalid_roi_rectangle');
  assert.equal(P.roisFromLandmarks(base.slice(0,468),640,480).reason,'expected_478_landmarks');
  assert.equal(P.roisFromLandmarks(base,0,480).reason,'invalid_source_dimensions');
  const invalid=base.map(p=>({...p}));invalid[22].x=NaN;
  assert.equal(P.roisFromLandmarks(invalid,640,480).reason,'invalid_landmark_coordinates');
  invalid[22].x=1000;
  assert.equal(P.roisFromLandmarks(invalid,640,480).reason,'landmark_int16_overflow');
});

test('RGB packing is exact at identity; independent OpenCV fixtures quantify resized-image rounding differences',t=>{
  const oracle=JSON.parse(fs.readFileSync(require.resolve('./preprocess-oracle.json'),'utf8'));
  for(const example of oracle.resizeCases){
    const rgba=source(example.width,example.height,(x,y)=>[(19*x+23*y)%256,(3*x+29*y+17)%256,(11*x+7*y+99)%256]);
    const actual=P.prepareInputs({...rgba,face:example.face,leftEye:example.leftEye,rightEye:example.rightEye});
    for(const key of ['face','left','right']){
      const expected=zlib.inflateSync(Buffer.from(example.opencvRgbUint8ZlibBase64[key],'base64'));
      assert.equal(actual[key].data.length,expected.length);
      let maxByteDifference=0,sumByteDifference=0,differentElements=0;
      for(let i=0;i<expected.length;i++){
        const value=Math.round(actual[key].data[i]*255),difference=Math.abs(value-expected[i]);
        maxByteDifference=Math.max(maxByteDifference,difference);sumByteDifference+=difference;if(difference)differentElements++;
      }
      // This is the measured bound of these oracle fixtures, not a universal
      // promise that every OpenCV build/image differs by at most two levels.
      assert.ok(maxByteDifference<=2,`${example.name}/${key}: ${maxByteDifference}`);
      if(example.name==='identity-face-and-eyes')assert.equal(maxByteDifference,0);
      t.diagnostic(JSON.stringify({case:example.name,tensor:key,opencv:oracle.opencvVersion,maxByteDifference,meanByteDifference:sumByteDifference/expected.length,differentElements}));
    }
  }
});
