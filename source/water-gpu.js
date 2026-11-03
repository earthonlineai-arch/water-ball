'use strict';
// Both render paths run exactly the same shader, mipmaps and FXAA pass.
async function createWaterGPURenderer(canvas,assets){
  const started=performance.now(),contextOptions={alpha:false,antialias:false,
    preserveDrawingBuffer:false,powerPreference:'low-power',failIfMajorPerformanceCaveat:false,depth:false,stencil:false};
  const gl=canvas.getContext('webgl2',contextOptions)||canvas.getContext('webgl2',{...contextOptions,powerPreference:'default'});
  if(!gl)throw new Error('WebGL 2 is unavailable.');
  const extension=gl.getExtension('KHR_parallel_shader_compile');
  const objects={programs:[],textures:[],buffers:[],targets:[]},timings={parallelCompile:!!extension};
  let disposed=false,contextLost=false,lossCallback;
  const lossHandler=event=>{event.preventDefault();contextLost=true;lossCallback?.(new Error('GPU context lost.'));};
  canvas.addEventListener('webglcontextlost',lossHandler);
  function dispose(){
    if(disposed)return;disposed=true;
    for(const value of objects.programs)gl.deleteProgram(value);
    for(const value of objects.textures)gl.deleteTexture(value);
    for(const value of objects.buffers)gl.deleteBuffer(value);
    for(const value of objects.targets)gl.deleteFramebuffer(value);
    if(lossHandler)canvas.removeEventListener('webglcontextlost',lossHandler);
  }
  async function compile(fragment,label){
    const at=performance.now(),program=gl.createProgram(),shaders=[];objects.programs.push(program);
    try{
      for(const [source,type] of [[assets.vertex,gl.VERTEX_SHADER],[fragment,gl.FRAGMENT_SHADER]]){
        const shader=gl.createShader(type);shaders.push(shader);gl.shaderSource(shader,source);
        gl.compileShader(shader);gl.attachShader(program,shader);
      }
      gl.bindAttribLocation(program,0,'position');gl.linkProgram(program);
      if(extension)while(!gl.getProgramParameter(program,extension.COMPLETION_STATUS_KHR)){
        if(disposed||contextLost)throw new Error(contextLost?'GPU context lost.':'Renderer disposed.');
        if(performance.now()-at>30000)throw new Error('GPU compilation timed out.');
        await new Promise(resolve=>setTimeout(resolve,30));
      }
      if(disposed||contextLost)throw new Error(contextLost?'GPU context lost.':'Renderer disposed.');
      if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(program)||'Shader linking failed.');
      timings[label+'CompileMs']=performance.now()-at;return program;
    }finally{for(const shader of shaders){gl.detachShader(program,shader);gl.deleteShader(shader);}}
  }
  async function decode(source){
    // Some embedded Chromium versions expose createImageBitmap but reject the
    // decoder options or a particular image format. The DOM image decoder was
    // used by earlier versions and remains a full-quality alternative.
    let bitmapError;
    if(typeof createImageBitmap==='function'){
      const [header,data]=source.split(','),raw=atob(data),bytes=new Uint8Array(raw.length);
      for(let i=0;i<raw.length;i++)bytes[i]=raw.charCodeAt(i);
      try{
        return await createImageBitmap(new Blob([bytes],{type:header.slice(5,header.indexOf(';'))}),
          {premultiplyAlpha:'none',colorSpaceConversion:'none'});
      }catch(error){bitmapError=error;}
    }
    if(typeof Image!=='function')throw new Error('Texture decoder unavailable in this renderer: '+String(bitmapError?.message||'ImageBitmap unsupported'));
    return new Promise((resolve,reject)=>{
      const image=new Image(),timer=setTimeout(()=>{image.onload=image.onerror=null;reject(new Error('Texture decoding timed out.'));},12000);
      image.onload=()=>{clearTimeout(timer);resolve(image);};
      image.onerror=()=>{clearTimeout(timer);reject(new Error('Texture decoding failed.'));};image.src=source;
    });
  }
  function texture(){const value=gl.createTexture();objects.textures.push(value);return value;}
  let normalImage,environmentImage;
  try{
    // Parallel decode and compilation; cleanup also covers partial failures.
    const results=await Promise.allSettled([compile(assets.fragment,'interaction'),compile(assets.antialias,'antialias'),decode(assets.normals),decode(assets.environment)]);
    if(results[2].status==='fulfilled')normalImage=results[2].value;
    if(results[3].status==='fulfilled')environmentImage=results[3].value;
    const failure=results.find(result=>result.status==='rejected');if(failure)throw failure.reason;
    if(disposed||contextLost)throw new Error(contextLost?'GPU context lost.':'Renderer disposed.');
    const program=results[0].value,postProgram=results[1].value;
    gl.useProgram(program);
    const uniforms={};
    for(const name of ['resolution','viewWindow','time','surfaceTime','surfaceClockEnabled','pointer','bodyShape','bodyWarp','beadCount','waveEnergy'])uniforms[name]=gl.getUniformLocation(program,name);
    const arrays=['beads','beadLinks','beadStyles','beadFusion','beadShape','beadStretch','beadBounds','waveOrigins','waveProfiles'];
    for(const name of arrays)uniforms[name]=gl.getUniformLocation(program,name+'[0]');
    const postUniforms={scene:gl.getUniformLocation(postProgram,'scene'),resolution:gl.getUniformLocation(postProgram,'resolution')};
    const buffer=gl.createBuffer();objects.buffers.push(buffer);gl.bindBuffer(gl.ARRAY_BUFFER,buffer);
    gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,3,-1,-1,3]),gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);gl.vertexAttribPointer(0,2,gl.FLOAT,false,0,0);
    const normal=texture();gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,normal);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,false);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,normalImage);gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.REPEAT);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
    gl.uniform1i(gl.getUniformLocation(program,'normalAtlas'),0);
    const environment=texture();gl.activeTexture(gl.TEXTURE1);gl.bindTexture(gl.TEXTURE_CUBE_MAP,environment);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL,gl.NONE);
    let face,ctx;
    try{face=typeof OffscreenCanvas==='function'?new OffscreenCanvas(256,256):null;ctx=face?.getContext('2d',{alpha:false});}
    catch(_){/* Partial implementations may throw instead of returning null. */}
    if(!ctx&&typeof document!=='undefined'){
      face=document.createElement('canvas');face.width=face.height=256;ctx=face.getContext('2d',{alpha:false});
    }
    if(!ctx)throw new Error('Environment texture canvas unavailable.');
    for(let i=0;i<6;i++){
      ctx.drawImage(environmentImage,(i%3)*256,Math.floor(i/3)*256,256,256,0,0,256,256);
      gl.texImage2D(gl.TEXTURE_CUBE_MAP_POSITIVE_X+i,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,face);
    }
    gl.generateMipmap(gl.TEXTURE_CUBE_MAP);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP,gl.TEXTURE_MIN_FILTER,gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
    for(const axis of [gl.TEXTURE_WRAP_S,gl.TEXTURE_WRAP_T,gl.TEXTURE_WRAP_R])gl.texParameteri(gl.TEXTURE_CUBE_MAP,axis,gl.CLAMP_TO_EDGE);
    gl.uniform1i(gl.getUniformLocation(program,'environmentMap'),1);
    const postTexture=texture();gl.activeTexture(gl.TEXTURE2);gl.bindTexture(gl.TEXTURE_2D,postTexture);
    for(const [key,value] of [[gl.TEXTURE_MIN_FILTER,gl.LINEAR],[gl.TEXTURE_MAG_FILTER,gl.LINEAR],[gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE],[gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE]])gl.texParameteri(gl.TEXTURE_2D,key,value);
    const target=gl.createFramebuffer();objects.targets.push(target);
    let width=0,height=0,frames=0;
    timings.readyMs=performance.now()-started;
    return{canvas,timings,dispose,
      onLoss(callback){lossCallback=callback;},
      get stats(){return{frames,width,height};},
      render(frame){
        if(disposed)return;
        gl.useProgram(program);gl.bindFramebuffer(gl.FRAMEBUFFER,target);
        if(width!==frame.width||height!==frame.height){
          width=frame.width;height=frame.height;canvas.width=width;canvas.height=height;
          gl.activeTexture(gl.TEXTURE2);gl.bindTexture(gl.TEXTURE_2D,postTexture);
          gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,width,height,0,gl.RGBA,gl.UNSIGNED_BYTE,null);
          gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,postTexture,0);
          if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE)throw new Error('Antialias target unavailable.');
        }
        gl.viewport(0,0,width,height);gl.uniform2f(uniforms.resolution,width,height);
        gl.uniform4fv(uniforms.viewWindow,frame.viewWindow);
        gl.uniform1f(uniforms.time,frame.time);gl.uniform1f(uniforms.surfaceTime,frame.surfaceTime);
        gl.uniform1i(uniforms.surfaceClockEnabled,1);gl.uniform2fv(uniforms.pointer,frame.pointer);
        gl.uniform3fv(uniforms.bodyShape,frame.bodyShape);gl.uniform2fv(uniforms.bodyWarp,frame.bodyWarp);
        gl.uniform1i(uniforms.beadCount,frame.beadCount);
        for(const name of arrays)gl.uniform4fv(uniforms[name],frame[name]);
        gl.uniform4fv(uniforms.waveEnergy,frame.waveEnergy);gl.drawArrays(gl.TRIANGLES,0,3);
        gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.useProgram(postProgram);
        gl.activeTexture(gl.TEXTURE2);gl.bindTexture(gl.TEXTURE_2D,postTexture);
        gl.uniform1i(postUniforms.scene,2);gl.uniform2f(postUniforms.resolution,width,height);gl.drawArrays(gl.TRIANGLES,0,3);
        if(frames===0&&gl.getError()!==gl.NO_ERROR)throw new Error('Initial GPU drawing failed.');
        frames++;
      }
    };
  }catch(error){dispose();throw error;}
  finally{normalImage?.close?.();environmentImage?.close?.();}
}

function waterGPUWorker(){
  let renderer;
  self.onmessage=async event=>{
    const message=event.data;
    try{
      if(message.type==='init'){
        renderer=await createWaterGPURenderer(message.canvas,message.assets);
        renderer.onLoss(error=>self.postMessage({type:'error',error:error.message}));
        self.postMessage({type:'ready',timings:renderer.timings});
      }else if(message.type==='render'){
        renderer.render(message.frame);self.postMessage({type:'frame',stats:renderer.stats});
      }else if(message.type==='capture'){
        self.postMessage({type:'capture',blob:await renderer.canvas.convertToBlob({type:'image/png'})});
      }
    }catch(error){self.postMessage({type:'error',error:String(error?.message||error)});}
  };
}

// At most one frame in flight and one newest pending frame. No worker rAF,
// duplicate simulation, bitmap readback or per-frame image transfers.
window.createWaterRenderDriver=async function(inputCanvas,assets,onError,options={}){
  const renderingCanvas=document.createElement('canvas');
  let worker,sourceURL,disposed=false,active=true,busy=false,pending=null,stats={frames:0,width:0,height:0};
  const captureWaiters=[];
  let pendingBuffer;
  function snapshot(frame){
    if(!pendingBuffer){
      pendingBuffer={};for(const [key,value] of Object.entries(frame))pendingBuffer[key]=ArrayBuffer.isView(value)?value.slice():value;
    }else for(const [key,value] of Object.entries(frame)){
      if(ArrayBuffer.isView(value))pendingBuffer[key].set(value);else pendingBuffer[key]=value;
    }
    return pendingBuffer;
  }
  let resolveFirstFrame;
  const firstFrame=new Promise(resolve=>{resolveFirstFrame=resolve;});
  function destroyWorker(){
    if(disposed)return;disposed=true;worker?.terminate();
    if(sourceURL)URL.revokeObjectURL(sourceURL);renderingCanvas.remove();
    for(const waiter of captureWaiters)waiter.reject(new Error('Renderer disposed.'));captureWaiters.length=0;
  }
  let workerFailure='';
  if(!options.preferMainThread&&typeof Worker==='function'&&typeof renderingCanvas.transferControlToOffscreen==='function'){
    try{
      renderingCanvas.setAttribute('aria-hidden','true');renderingCanvas.style.pointerEvents='none';
      renderingCanvas.style.position='absolute';renderingCanvas.style.opacity='0';inputCanvas.before(renderingCanvas);
      sourceURL=URL.createObjectURL(new Blob([createWaterGPURenderer.toString(),'\n(',waterGPUWorker.toString(),')();'],{type:'text/javascript'}));
      worker=new Worker(sourceURL);
      const offscreen=renderingCanvas.transferControlToOffscreen();
      const timings=await new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>reject(new Error('Background GPU initialization timed out.')),45000);
        worker.onerror=event=>{clearTimeout(timer);reject(new Error(event.message||'Background GPU unavailable.'));};
        worker.onmessage=event=>{
          if(event.data.type==='ready'){clearTimeout(timer);resolve(event.data.timings);}
          if(event.data.type==='error'){clearTimeout(timer);reject(new Error(event.data.error));}
        };
        worker.postMessage({type:'init',canvas:offscreen,assets},[offscreen]);
      });
      worker.onerror=event=>onError(new Error(event.message||'Background GPU failed.'));
      worker.onmessage=event=>{
        const message=event.data;
        if(message.type==='error'){onError(new Error(message.error));return;}
        if(message.type==='capture'){captureWaiters.shift()?.resolve(message.blob);return;}
        if(message.type!=='frame')return;
        stats=message.stats;busy=false;renderingCanvas.style.opacity='1';resolveFirstFrame();
        if(pending&&active){const frame=pending;pending=null;busy=true;worker.postMessage({type:'render',frame});}
      };
      return{canvas:renderingCanvas,backend:'webgl2-worker',timings,firstFrame,
        get stats(){return stats;},dispose:destroyWorker,
        setActive(value){active=value;if(!active)pending=null;},
        render(frame){
          if(disposed||!active)return;
          if(busy){pending=snapshot(frame);return;}
          busy=true;worker.postMessage({type:'render',frame});
        },
        capture(){return new Promise((resolve,reject)=>{captureWaiters.push({resolve,reject});worker.postMessage({type:'capture'});});}
      };
    }catch(error){workerFailure=String(error?.message||error);destroyWorker();/* Retry the same full material on the main thread. */}
  }
  const renderer=await createWaterGPURenderer(inputCanvas,assets);renderer.onLoss(onError);
  if(workerFailure)renderer.timings.workerFailure=workerFailure;
  return{...renderer,backend:'webgl2',get stats(){return renderer.stats;},setActive(){},
    async capture(){return new Promise(resolve=>inputCanvas.toBlob(resolve,'image/png'));}};
};
