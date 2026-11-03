'use strict';
(() => {
  const canvas=document.getElementById('water');
  const poster=document.getElementById('fallback');
  const posterSource=poster.getAttribute?.('data-src')||poster.getAttribute?.('src')||poster.src;
  const staticScene=document.getElementById('static-fallback');
  const button=document.getElementById('motion');
  const reduced=matchMedia('(prefers-reduced-motion: reduce)');
  const settings={maxPixels:880000,maxFPS:24,seed:.73};
  let renderCrop=.92;
  const viewData=new Float32Array(4);
  let ready=false,dead=false,loading=false,visible=true,paused=false;
  let backend='poster',renderDriver,gpuAssets,renderWidth=0,renderHeight=0;
  let watchdog=0,presentationTimer=0;
  let lastError='',drawCount=0;
  let stage='poster',interactionReady=false,flowEnabled=false,surfaceTime=0,startupRun=0;
  let enhancementError='',initializingAt=0;
  let startupTimings={};
  let frame=0,lastStamp=0,lastRenderedStamp=0,simTime=0,resizeNeeded=true;
  let lastDrawMs=0;
  const interactionHint='按住向外拉 · 拉断后自由拖动 · 松手汇回';
  const limitedHint='当前浏览器功能受限，无法显示页面动态效果。';
  function hideStaticFallback(){
    poster.hidden=true;
    if(staticScene)staticScene.hidden=true;
  }
  function showStaticFallback(){
    // Decode this tiny shared atlas only after both full-quality render paths fail.
    if(posterSource)poster.src=posterSource;
    poster.hidden=false;
    if(staticScene){
      const atlas=document.getElementById('static-droplets-data')?.textContent.trim();
      if(atlas)staticScene.style.setProperty('--droplet-atlas','url("data:image/webp;base64,'+atlas+'")');
      staticScene.hidden=false;
    }
  }
  let progressFrames=-1,progressAt=0,renderStalled=false;
  let recoveringOnMain=false,recoveryReason='';
  const pointer={x:0,y:0,targetX:0,targetY:0};
  const MAX_BEADS=8,MANUAL_BEADS=5,MAX_WAVES=4,DRAG_Z=.12,PINCH_TIME=.14,AMBIENT_GAP=.25;
  const HOP_DURATIONS=[.30,.25],HOP_HEIGHTS=[1,.68],TOUCHDOWN_ENERGIES=[.62,.48];
  const TOTAL_HOP_TIME=HOP_DURATIONS.reduce((sum,duration)=>sum+duration,0),ABSORPTION_TIME=.65;
  const BODY_BOUND=1.28;
  // Four low-order damped modes: axial stretch, diagonal shear, lateral bend,
  // and volume response. They affect actual geometry, not only surface shading.
  const body={modes:[0,0,0,0],velocity:[0,0,0,0],target:[0,0,0,0],impulses:0};
  const BODY_LIMITS=[.055,.085,.055,.024],BODY_SPEEDS=[.28,.45,.30,.13];
  const beads=Array.from({length:MAX_BEADS},()=>null);
  const waves=Array.from({length:MAX_WAVES},()=>({origin:[1,0,0],age:4,energy:0}));
  const beadData=new Float32Array(MAX_BEADS*4),linkData=new Float32Array(MAX_BEADS*4),styleData=new Float32Array(MAX_BEADS*4);
  const waveData=new Float32Array(MAX_WAVES*4),waveEnergy=new Float32Array(MAX_WAVES);
  const waveProfiles=new Float32Array(MAX_WAVES*4);
  const bodyShapeData=new Float32Array(3),bodyWarpData=new Float32Array(2);
  const gesture={id:null,mode:'idle',bead:-1,last:null};
  const fusionData=new Float32Array(MAX_BEADS*4),COALESCE_TIME=.38;
  const shapeData=new Float32Array(MAX_BEADS*4);
  const gpuSlots=new Int8Array(MAX_BEADS);
  const stretchData=new Float32Array(MAX_BEADS*4),boundsData=new Float32Array(MAX_BEADS*4);
  let gpuBeadCount=0;
  const counters={created:0,emerged:0,internalCancelled:0,detached:0,merged:0,ambientSpawned:0,contacts:0,recontacts:0,clicks:0,waves:0,capacityHits:0,spawnRejected:0,spawnDeferred:0,spacingWaits:0,coalesced:0};
  let nextAmbient=.75,lastRadius=.12,nextBeadId=0;


  const add=(a,b)=>a.map((v,i)=>v+b[i]),sub=(a,b)=>a.map((v,i)=>v-b[i]);
  const mul=(a,s)=>a.map(v=>v*s),dot=(a,b)=>a.reduce((s,v,i)=>s+v*b[i],0);
  const length=a=>Math.hypot(...a),unit=a=>mul(a,1/Math.max(1e-9,length(a)));
  const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
  const clamp=(n,a,b)=>Math.max(a,Math.min(b,n));
  const smooth=t=>{t=clamp(t,0,1);return t*t*(3-2*t);};
  function shape(){return[
    clamp(1+.009*Math.sin(simTime*.7)+body.modes[0]+body.modes[3]*.5,.95,1.06),
    clamp(1.035+.012*Math.sin(simTime*.7)-body.modes[0]+body.modes[3]*.5,.98,1.105),
    clamp(.99-body.modes[3]*.4,.965,1.015)
  ];}
  function warp(){return[
    clamp(.10+.018*Math.sin(simTime*.42)+body.modes[2],.035,.17),
    clamp(.035*Math.sin(simTime*.31+.6)+body.modes[1],-.12,.12)
  ];}
  function bodyMoving(){return body.modes.some((v,i)=>Math.abs(v)>.00006||Math.abs(body.velocity[i])>.00012);}
  function bodyBasis(position){
    const n=unit(position),xy=Math.max(.1,Math.hypot(n[0],n[1])),x=n[0]/xy,y=n[1]/xy;
    return[x*x-y*y,2*x*y,x,1];
  }
  function bodyImpulse(position,intensity){
    const basis=bodyBasis(position),scale=[.15,.23,.18,.055];
    for(let i=0;i<4;i++)body.velocity[i]=clamp(body.velocity[i]+basis[i]*scale[i]*intensity,-BODY_SPEEDS[i],BODY_SPEEDS[i]);
    body.impulses++;
  }
  function stepBody(dt){
    const force=[0,0,0,0],gain=[.075,.14,.085,.025];
    for(const bead of beads){
      if(!bead||bead.mode==='internal'||bead.mode==='dissolving'||(paused&&bead.kind==='ambient'))continue;
      const proximity=1-smooth((mainGap(bead.position)-.02)/1.05);
      const size=clamp(bead.baseRadius/.12,.6,1.45),growth=bead.radius/Math.max(.001,bead.baseRadius);
      let response=.78;
      if(bead.mode==='attached'||bead.mode==='pinching')response=1.05;
      else if(bead.mode==='merging'){
        // Lift relaxes the local contact pressure; every touchdown also supplies
        // a separate impulse, so repeated hops visibly reshape the main body.
        response=.35+.55*Math.max(0,dot(bead.velocity,unit(bead.position))/.20);
      }
      const strength=proximity*size*growth*response,basis=bodyBasis(bead.position);
      for(let i=0;i<4;i++)force[i]+=basis[i]*gain[i]*strength;
    }
    for(let i=0;i<4;i++)body.target[i]=force[i]/(1+Math.abs(force[i])/BODY_LIMITS[i]);
    const count=Math.max(1,Math.ceil(dt*120)),h=dt/count,k=[30,24,20,32],damping=[7.5,6.8,6.2,8];
    for(let substep=0;substep<count;substep++)for(let i=0;i<4;i++){
      body.velocity[i]=clamp(body.velocity[i]+(k[i]*(body.target[i]-body.modes[i])-damping[i]*body.velocity[i])*h,-BODY_SPEEDS[i],BODY_SPEEDS[i]);
      body.modes[i]+=body.velocity[i]*h;
      if(Math.abs(body.modes[i])>BODY_LIMITS[i]){body.modes[i]=clamp(body.modes[i],-BODY_LIMITS[i],BODY_LIMITS[i]);body.velocity[i]*=.25;}
      if(Math.abs(body.target[i])<1e-9&&Math.abs(body.modes[i])<.00003&&Math.abs(body.velocity[i])<.00006){body.modes[i]=0;body.velocity[i]=0;}
    }
    // Surface attachment points follow the same body coefficients sent to GLSL.
    for(const bead of beads)if(bead&&bead.link>.001&&!(paused&&bead.kind==='ambient'))bead.anchor=surfaceAt(bead.anchor);
  }
  function bodyMetric(x,y,z,s,w){
    return Math.hypot((x-w[0]*(y*y-.30)-w[1]*y)/s[0],y/s[1],z/s[2]);
  }
  function surfaceAt(p){
    // The bent body remains star-shaped around the origin, but its radial
    // surface is no longer obtained by simply dividing by an ellipsoid metric.
    const s=shape(),w=warp(),direction=length(p)>1e-9?unit(p):[0,0,1];
    const x2=-w[0]*direction[1]*direction[1]/s[0];
    const x1=(direction[0]-w[1]*direction[1])/s[0],x0=w[0]*.30/s[0];
    const yz=(direction[1]/s[1])**2+(direction[2]/s[2])**2;
    let lo=0,hi=BODY_BOUND,t=1/Math.hypot(direction[0]/s[0],direction[1]/s[1],direction[2]/s[2]);
    // Bracketed Newton solves the same quartic radial surface. Usually 3–5
    // scalar iterations replace 29 repeated three-dimensional metric samples.
    for(let i=0;i<12;i++){
      const x=(x2*t+x1)*t+x0,value=x*x+yz*t*t-1;
      if(Math.abs(value)<1e-12)return mul(direction,t);
      if(value>0)hi=t;else lo=t;
      const derivative=2*x*(2*x2*t+x1)+2*yz*t;
      const candidate=t-value/derivative;
      t=Number.isFinite(candidate)&&candidate>lo&&candidate<hi?candidate:(lo+hi)*.5;
    }
    return mul(direction,t);
  }
  function mainGap(p){return length(p)-length(surfaceAt(p));}
  function safelyInside(p,radius){
    const s=shape(),w=warp(),clearance=radius+.012;
    const ax=1/s[0],ay=1/s[1],az=1/s[2];
    function safe(scale){
      const x=p[0]*scale,y=p[1]*scale,z=p[2]*scale;
      // Bound the warp Jacobian over the entire droplet, not just its center.
      // The resulting Lipschitz inset guarantees its complete sphere is inside.
      const shear=(2*Math.abs(w[0])*(Math.abs(y)+clearance)+Math.abs(w[1]))/s[0];
      const trace=ax*ax+ay*ay+shear*shear;
      const lipschitz=Math.max(az,Math.sqrt((trace+Math.sqrt(Math.max(0,trace*trace-4*ax*ax*ay*ay)))*.5));
      return bodyMetric(x,y,z,s,w)+clearance*lipschitz<=1;
    }
    if(safe(1))return[...p];
    let lo=0,hi=1;
    for(let i=0;i<29;i++){const t=(lo+hi)*.5;if(safe(t))lo=t;else hi=t;}
    return mul(p,lo);
  }
  function cameraRay(point){
    // Picking stays in full-page coordinates even when the GPU canvas trims blank margins.
    const rect={left:0,top:0,width:innerWidth,height:innerHeight},size=Math.max(1,Math.min(rect.width,rect.height));
    const x=(point.x-rect.left-rect.width*.5)/size,y=(rect.height*.5-point.y+rect.top)/size;
    const origin=[pointer.x*.27,.03+pointer.y*.15,4.6];
    const forward=unit(mul(origin,-1)),right=unit(cross(forward,[0,1,0])),up=cross(right,forward);
    return{origin,direction:unit(add(mul(forward,3.15),add(mul(right,x*2.82),mul(up,y*2.82))))};
  }
  function mainIntersection(point){
    const ray=cameraRay(point),s=shape(),w=warp(),d=ray.direction;
    const center=-dot(ray.origin,d),o=add(ray.origin,mul(d,center));
    const bound=BODY_BOUND*BODY_BOUND-dot(o,o);
    if(bound<0)return{...ray,h:-1,t:center,near:-1,hit:false};
    const reach=Math.sqrt(bound),start=-reach,end=reach;
    // Along a ray q.x is quadratic and |q|^2-1 is quartic. Its derivative is
    // monotone within this mildly warped body's bounded envelope. Scalar bisection
    // finds the closest ray point even for grazing rays without sphere marching.
    const x2=-w[0]*d[1]*d[1]/s[0];
    const x1=(d[0]-(2*w[0]*o[1]+w[1])*d[1])/s[0];
    const x0=(o[0]-w[0]*(o[1]*o[1]-.30)-w[1]*o[1])/s[0];
    const y0=o[1]/s[1],y1=d[1]/s[1],z0=o[2]/s[2],z1=d[2]/s[2];
    function field(t){const x=(x2*t+x1)*t+x0,y=y0+y1*t,z=z0+z1*t;return x*x+y*y+z*z-1;}
    function slope(t){return((x2*t+x1)*t+x0)*(2*x2*t+x1)+(y0+y1*t)*y1+(z0+z1*t)*z1;}
    let lo=start,hi=end;
    if(slope(lo)>=0)hi=lo;
    else if(slope(hi)<=0)lo=hi;
    else for(let i=0;i<34;i++){const t=(lo+hi)*.5;if(slope(t)>0)hi=t;else lo=t;}
    const closest=(lo+hi)*.5,minimum=field(closest);
    if(minimum>0)return{...ray,h:-minimum,t:center+closest,near:-1,hit:false};
    lo=start;hi=closest;
    for(let i=0;i<34;i++){const t=(lo+hi)*.5;if(field(t)>0)lo=t;else hi=t;}
    const near=center+(lo+hi)*.5;
    return{...ray,h:-minimum,t:center+closest,near,hit:near>0};
  }
  function worldPoint(point){
    const ray=cameraRay(point),t=(DRAG_Z-ray.origin[2])/ray.direction[2];
    return add(ray.origin,mul(ray.direction,t));
  }
  function boundaryBetween(a,b){
    // The warped outline is tested using the very same ray and camera as GLSL.
    // Bisection finds the actual exit of the latest pointer segment, not the press angle.
    let lo=0,hi=1;
    for(let i=0;i<23;i++){
      const m=(lo+hi)*.5,p={x:a.x+(b.x-a.x)*m,y:a.y+(b.y-a.y)*m};
      if(mainIntersection(p).hit)lo=m;else hi=m;
    }
    const u=(lo+hi)*.5,point={x:a.x+(b.x-a.x)*u,y:a.y+(b.y-a.y)*u};
    const ray=mainIntersection(point);
    return surfaceAt(add(ray.origin,mul(ray.direction,ray.t)));
  }
  function randomRadius(){
    let r=.085+Math.random()*.095;
    if(Math.abs(r-lastRadius)<.014)r=clamp(r+(r>.1325?-.026:.026),.085,.18);
    lastRadius=r;return r;
  }
  function emitWave(origin,energy){
    const free=waves.findIndex(w=>w.energy===0);
    const index=free>=0?free:waves.reduce((old,w,i)=>w.age>waves[old].age?i:old,0);
    waves[index]={origin:unit(origin),age:0,energy:clamp(energy,.015,1.2)};counters.waves++;
  }
  function newBead(kind,position,radius,anchor,mode){
    const id=++nextBeadId;
    // Stable optical identity also seeds each droplet's independent oscillation.
    const appearance=Object.freeze([
      ((id*.6180339887498949+Math.random()*.20)%1)*Math.PI*2,
      -1.2+Math.random()*2.4,.45+Math.random()*.55,
      (id*.7548776662466927+Math.random()*.20)%1
    ]);
    return{id,appearance,kind,position:[...position],velocity:[0,0,0],radius,baseRadius:radius,
      anchor:[...anchor],mode,link:mode==='attached'?1:0,age:0,mergeAge:0,
      pinchAge:0,detachLimit:.4+radius*.65,contact:false,mergeOrigin:null};
  }
  function dropletShape(bead){
    const phase=bead.appearance[3]*Math.PI*2,t=bead.shapeTime||0;
    const u=.050*Math.sin(t*5.2+phase)+.018*Math.sin(t*8.1+phase*1.7);
    const v=.046*Math.sin(t*4.6+phase*1.3)+.015*Math.cos(t*7.3+phase);
    return[Math.exp(u),Math.exp(v),Math.exp(-u-v),.065*Math.sin(t*5.7+phase*.8)];
  }
  function stretchFactor(bead){return 1+(bead.inertiaAmount||0);}
  function contactReach(bead,direction){
    const axis=bead.inertiaAxis||[1,0,0],factor=stretchFactor(bead),along=dot(axis,direction);
    return bead.radius*Math.sqrt(Math.max(0,1-along*along)/factor+along*along*factor*factor);
  }
  function undoStretch(vector,bead){
    const axis=bead.inertiaAxis||[1,0,0],factor=stretchFactor(bead),root=Math.sqrt(factor);
    const along=dot(vector,axis)*(1/factor-root);
    return vector.map((v,i)=>v*root+axis[i]*along);
  }
  function stepInertia(bead,dt){
    const previous=bead.inertiaPosition||bead.position;
    const held=gesture.id!==null&&beads[gesture.bead]===bead;
    const velocity=mul(sub(bead.position,previous),1/Math.max(dt,.001));
    const blend=1-Math.exp(-dt/.095),motion=bead.inertiaMotion||[0,0,0];
    const bounded=mul(velocity,Math.min(1,4/Math.max(.001,length(velocity))));
    bead.inertiaMotion=add(mul(motion,1-blend),mul(bounded,blend));
    const speed=length(bead.inertiaMotion);
    const eligible=bead.kind==='interactive'&&!['internal','dissolving'].includes(bead.mode);
    const lag=held&&bead.dragTarget?sub(bead.dragTarget,bead.position):[0,0,0];
    const lagSize=length(lag),scale=bead.baseRadius*1.3+.035;
    const target=eligible?(held?.44*(1-Math.exp(-lagSize/scale)):.20*speed/(speed+1.2)):0;
    bead.inertiaAxis=bead.inertiaAxis||[1,0,0];
    if(eligible&&(lagSize>.004||speed>.03)){
      let direction=unit(lagSize>.004?lag:bead.inertiaMotion);
      if(dot(direction,bead.inertiaAxis)<0)direction=mul(direction,-1);
      const turn=1-Math.exp(-dt*8);
      bead.inertiaAxis=unit(add(mul(bead.inertiaAxis,1-turn),mul(direction,turn)));
    }
    // Exact critically damped response avoids frame-rate-dependent spring kicks.
    const omega=10,decay=Math.exp(-omega*dt),error=(bead.inertiaAmount||0)-target;
    const impulse=(bead.inertiaVelocity||0)+omega*error;
    let amount=target+(error+impulse*dt)*decay,v=((bead.inertiaVelocity||0)-omega*impulse*dt)*decay;
    if(amount<.000001){amount=0;v=0;}
    bead.inertiaAmount=amount;bead.inertiaVelocity=v;
    if(target<.00001&&amount<.00001&&Math.abs(v)<.0001)bead.inertiaAmount=bead.inertiaVelocity=0;
    bead.inertiaPosition=[...bead.position];bead.inertiaSpeed=speed;
  }
  function dragPosition(bead,point){
    const cursor=worldPoint(point),position=bead.grabOffset?sub(cursor,bead.grabOffset):cursor;
    if(!bead.dragOffset)return position;
    // A press near the rim starts with the entire new bead inside the main volume.
    // Release that initial inset continuously over the first short hand movement.
    const fade=1-smooth(length(sub(position,bead.dragStart))/(.22+bead.baseRadius));
    return sub(position,mul(bead.dragOffset,fade));
  }
  function stepHeldDrag(bead,dt){
    if(!bead.dragTarget||!['attached','pinching','detached'].includes(bead.mode))return;
    const previous=[...bead.position],start=bead.dragSample||previous;
    const steps=Math.max(1,Math.ceil(dt*120)),h=dt/steps,omega=24,decay=Math.exp(-omega*h);
    for(let i=0;i<steps;i++)for(let axis=0;axis<3;axis++){
      const goal=start[axis]+(bead.dragTarget[axis]-start[axis])*(i+1)/steps;
      const error=bead.position[axis]-goal,impulse=bead.velocity[axis]+omega*error;
      bead.position[axis]=goal+(error+impulse*h)*decay;
      bead.velocity[axis]=(bead.velocity[axis]-omega*impulse*h)*decay;
    }
    bead.dragSample=[...bead.dragTarget];
    coalesceTouching(bead,previous);
    const gap=mainGap(bead.position);
    if(bead.mode==='attached'&&gap>bead.baseRadius*.12&&length(sub(bead.position,bead.anchor))>bead.detachLimit){
      bead.mode='pinching';bead.pinchAge=0;emitWave(bead.anchor,.2+bead.radius);
    }
    if((bead.mode==='detached'||bead.mode==='pinching')&&gap<bead.baseRadius*.70)startMerge(bead);
    else if(bead.mode==='attached'&&bead.dragReenter&&gap<bead.baseRadius*.70)startMerge(bead);
  }
  function dissolveInternal(bead){
    bead.mode='dissolving';bead.growAge=null;bead.dissolveAge=0;
    bead.dissolveOrigin=[...bead.position];bead.dissolveRadius=bead.radius;bead.link=0;
    bead.dissolveTarget=safelyInside(bead.position,bead.baseRadius*1.16);
    bead.velocity=[0,0,0];
  }
  function transferVolume(donor,target,progress){
    const total=donor.fusionVolume,remaining=total*(1-progress);
    const volume=Math.max(0,total*progress-donor.fusionTransferred);
    target.radius=Math.cbrt(target.radius**3+volume);target.baseRadius=target.radius;
    target.detachLimit=.4+target.baseRadius*.65;
    donor.fusionTransferred=total*progress;
    donor.radius=Math.cbrt(Math.max(0,remaining));donor.baseRadius=donor.radius;
  }
  function finishCoalescence(target){
    beads.forEach((donor,i)=>{
      if(donor&&donor.mode==='coalescing'&&donor.fusionTarget===target.id){
        transferVolume(donor,target,1);beads[i]=null;counters.coalesced++;
      }
    });
  }
  function coalesceTouching(target,previous=target.position){
    if(gesture.id===null||gesture.mode!=='bead'||beads[gesture.bead]!==target||
       !['attached','pinching','detached'].includes(target.mode))return;
    const segment=sub(target.position,previous),span=dot(segment,segment);
    for(const donor of beads){
      if(!donor||donor===target||donor.radius<.015||
         !['ambient','homing','detached','returning','attached','pinching'].includes(donor.mode))continue;
      // Main-body contact owns its own absorption; only visible free water joins.
      if(mainGap(donor.position)<donor.radius*.9||mainGap(target.position)<target.radius*.9)continue;
      const along=span>1e-12?clamp(dot(sub(donor.position,previous),segment)/span,0,1):1;
      const closest=add(previous,mul(segment,along));
      const separation=sub(donor.position,closest),distance=length(separation),normal=distance>1e-9?mul(separation,1/distance):[1,0,0];
      if(distance>(contactReach(target,normal)+contactReach(donor,normal))*1.06)continue;
      finishCoalescence(donor);
      target.growAge=null;donor.growAge=null;
      donor.mode='coalescing';donor.link=0;
      donor.fusionTarget=target.id;donor.fusionAge=0;
      donor.fusionVolume=donor.radius**3;donor.fusionTransferred=0;
      // Preserve incoming position and velocity. Surface tension progressively
      // entrains the arriving water instead of freezing it at first contact.
      donor.fusionOrigin=[...donor.position];donor.fusionVelocity=[...donor.velocity];
      donor.fusionLastTarget=[...target.position];
    }
  }
  function stepCoalescence(dt){
    beads.forEach((donor,i)=>{
      if(!donor||donor.mode!=='coalescing')return;
      const target=beads.find(b=>b&&b.id===donor.fusionTarget);
      if(!target){donor.mode='homing';donor.fusionTarget=null;return;}
      donor.fusionAge=Math.min(COALESCE_TIME,donor.fusionAge+dt);
      const u=donor.fusionAge/COALESCE_TIME,progress=smooth(u);
      transferVolume(donor,target,progress);
      const carry=u*(1-u)*(1-u)*COALESCE_TIME;
      const derivative=6*u*(1-u)/COALESCE_TIME,carryDerivative=1-4*u+3*u*u;
      const targetVelocity=mul(sub(target.position,donor.fusionLastTarget),1/Math.max(dt,1e-6));
      donor.position=add(add(mul(donor.fusionOrigin,1-progress),mul(target.position,progress)),mul(donor.fusionVelocity,carry));
      donor.velocity=add(add(mul(sub(target.position,donor.fusionOrigin),derivative),mul(targetVelocity,progress)),mul(donor.fusionVelocity,carryDerivative));
      donor.fusionLastTarget=[...target.position];
      if(donor.fusionAge>=COALESCE_TIME){beads[i]=null;counters.coalesced++;}
    });
  }
  function startMerge(bead){
    if(bead.mode==='merging')return;
    finishCoalescence(bead);
    bead.mode='merging';bead.mergeAge=0;bead.mergeOrigin=[...bead.position];
    bead.growAge=null;
    const normal=unit(bead.position);
    const extent=bead.radius;
    bead.anchor=surfaceAt(bead.position);
    // Freeze the destination at contact so the main sphere's ambient breathing
    // cannot push a merging bead outward. Also handle deep manual re-entry.
    bead.mergeTarget=safelyInside(bead.position,extent+.035);
    bead.mergeRadius=bead.radius;bead.mergeLink=bead.link;bead.mergeDuration=TOTAL_HOP_TIME+ABSORPTION_TIME;
    bead.mergeNormal=normal;bead.mergeRebound=(.020+.005*bead.appearance[3])*smooth((mainGap(bead.position)+.03)/.09);
    bead.mergeTouchdowns=0;
    bead.contact=true;counters.contacts++;
    bodyImpulse(bead.anchor,-.72*clamp(bead.baseRadius/.12,.65,1.35));
    emitWave(bead.anchor,.65);
    if(gesture.bead>=0&&beads[gesture.bead]===bead){gesture.bead=-1;gesture.mode='consumed';}
  }
  function spawnAmbient(){
    const index=beads.findIndex((b,i)=>i>=MANUAL_BEADS&&!b);if(index<0)return false;
    for(let attempt=0;attempt<16;attempt++){
      const angle=Math.random()*Math.PI*2,distance=1.65+Math.random()*.65;
      const position=[Math.cos(angle)*distance,Math.sin(angle)*distance,DRAG_Z];
      const radius=.075+Math.random()*.09,direction=unit(position);
      const clear=beads.every(other=>{
        if(!other)return true;
        const clearance=radius+other.baseRadius+AMBIENT_GAP;
        if(length(sub(position,other.position))<clearance)return false;
        // Separate whole radial corridors, not merely the initial spawn points.
        // The extra .04 accommodates the small contact recoil at the main sphere.
        const chord=1.98*Math.sqrt(Math.max(0,(1-dot(direction,unit(other.position)))*.5));
        return chord>=clearance+.04;
      });
      if(!clear){counters.spawnRejected++;continue;}
      const bead=newBead('ambient',position,radius,surfaceAt(position),'ambient');
      bead.radius=0;bead.speed=.22+Math.random()*.10;beads[index]=bead;counters.ambientSpawned++;return true;
    }
    counters.spawnDeferred++;return false;
  }
  function ambientStep(bead,dt){
    const direction=unit(mul(bead.position,-1));let travel=bead.speed*dt;
    for(const other of beads){
      if(!other||other===bead)continue;
      // A held droplet invites contact; ordinary traffic still keeps its gap.
      if(gesture.id!==null&&gesture.mode==='bead'&&beads[gesture.bead]===other)continue;
      const delta=sub(bead.position,other.position);
      const clearance=bead.baseRadius+other.baseRadius+AMBIENT_GAP+Math.min(.06,length(other.velocity)*dt);
      const c=dot(delta,delta)-clearance*clearance,b=dot(delta,direction);
      if(c<0){if(b<0)travel=0;continue;}
      const discriminant=b*b-c;if(discriminant<0)continue;
      const entry=-b-Math.sqrt(discriminant);
      if(entry>=0&&entry<travel)travel=Math.max(0,entry-.002);
    }
    if(travel<bead.speed*dt*.95)counters.spacingWaits++;
    bead.velocity=mul(direction,travel/Math.max(dt,1e-6));
    bead.position=add(bead.position,mul(direction,travel));
  }
  function moving(){
    return gesture.id!==null||bodyMoving()||waves.some(w=>w.energy>0)||beads.some(b=>b&&((b.inertiaAmount||0)>.00001||Math.abs(b.inertiaVelocity||0)>.0001))||beads.some(b=>b&&b.mode==='coalescing')||beads.some(b=>b&&b.kind==='interactive'&&
      (b.mode==='returning'||b.mode==='homing'||b.mode==='pinching'||b.mode==='merging'||b.mode==='dissolving'||length(b.velocity)>.003));
  }
  function stepBeads(dt){
    for(let i=0;i<MAX_BEADS;i++){
      const bead=beads[i];if(!bead)continue;
      if(!paused||bead.kind==='interactive'||bead.mode==='coalescing')bead.shapeTime=(bead.shapeTime||0)+dt;
    }
    const held=gesture.id!==null?beads[gesture.bead]:null;
    if(held){stepHeldDrag(held,dt);coalesceTouching(held);}
    stepCoalescence(dt);
    // Automatic traffic and its fusion pause together. Manual return remains responsive.
    if(!paused&&interactionReady){nextAmbient-=dt;if(nextAmbient<=0){nextAmbient=spawnAmbient()?(1.65+Math.random()*.35)/1.44:.35+Math.random()*.25;}}
    for(const wave of waves){if(wave.energy>0){wave.age+=dt;if(wave.age>3.2)wave.energy=0;}}
    const steps=Math.max(1,Math.ceil(dt*120)),h=dt/steps;
    for(let index=0;index<MAX_BEADS;index++){
      const bead=beads[index];if(!bead||bead.mode==='coalescing'||(bead.kind==='ambient'&&paused))continue;
      const wasMerging=bead.mode==='merging';
      const held=gesture.bead===index&&gesture.id!==null;
      bead.age+=dt;
      if(bead.mode==='internal'&&!bead.dragMoved)bead.position=safelyInside(bead.position,bead.baseRadius*1.16);
      if(bead.growAge!==undefined&&bead.growAge!==null){
        bead.growAge+=dt;bead.radius=bead.baseRadius*smooth(bead.growAge/.16);
        if(bead.growAge>=.16)bead.growAge=null;
      }
      if(bead.mode==='ambient'){
        bead.radius=bead.baseRadius*smooth(bead.age/.55);
        ambientStep(bead,dt);
        if(mainGap(bead.position)<bead.baseRadius*.88)startMerge(bead);
      }else if(bead.mode==='pinching'){
        bead.pinchAge+=dt;bead.link=1-smooth(bead.pinchAge/PINCH_TIME);
        if(bead.pinchAge>=PINCH_TIME){bead.mode=held?'detached':'homing';bead.link=0;counters.detached++;}
      }else if(bead.mode==='returning'){
        const target=safelyInside(bead.anchor,bead.baseRadius+.025);
        for(let j=0;j<steps;j++){
          const force=sub(mul(sub(target,bead.position),14),mul(bead.velocity,5.4));
          bead.velocity=add(bead.velocity,mul(force,h));
          const speed=length(bead.velocity);if(speed>3)bead.velocity=mul(bead.velocity,3/speed);
          bead.position=add(bead.position,mul(bead.velocity,h));
        }
        if(mainGap(bead.position)<bead.baseRadius*.65)startMerge(bead);
      }else if(bead.mode==='homing'&&!held){
        // A detached bead flies freely until contact. No artificial tether follows it.
        const target=mul(surfaceAt(bead.position),.83);
        for(let j=0;j<steps;j++){
          const force=sub(mul(sub(target,bead.position),1.45),mul(bead.velocity,1.9));
          bead.velocity=add(bead.velocity,mul(force,h));
          const speed=length(bead.velocity);if(speed>.78)bead.velocity=mul(bead.velocity,.78/speed);
          bead.position=add(bead.position,mul(bead.velocity,h));
        }
        if(mainGap(bead.position)<bead.baseRadius*.70)startMerge(bead);
      }else if(bead.mode==='dissolving'){
        bead.dissolveAge+=dt;const u=smooth(bead.dissolveAge/.24);
        bead.position=add(mul(bead.dissolveOrigin,1-u),mul(bead.dissolveTarget,u));
        bead.radius=bead.dissolveRadius*(1-u);
        if(bead.dissolveAge>=.24){beads[index]=null;counters.internalCancelled++;continue;}
      }
      if(bead.mode==='merging'&&wasMerging){
        bead.mergeAge+=dt;
        // Two visible, progressively smaller hops retain the bead's full radius.
        // Each recontact launches its own outward wave, then a final .65-second
        // absorption begins. Position and velocity are continuous at every join.
        let boundary=0;
        for(let hop=0;hop<HOP_DURATIONS.length;hop++){
          boundary+=HOP_DURATIONS[hop];
          if(bead.mergeAge+1e-9>=boundary&&bead.mergeTouchdowns===hop){
            emitWave(bead.anchor,TOUCHDOWN_ENERGIES[hop]);bead.mergeTouchdowns++;counters.recontacts++;
            bodyImpulse(bead.anchor,-.48*HOP_HEIGHTS[hop]*clamp(bead.baseRadius/.12,.65,1.35));
          }
        }
        const v=clamp((bead.mergeAge-TOTAL_HOP_TIME)/ABSORPTION_TIME,0,1);
        const travel=smooth(v),derivative=6*v*(1-v)/ABSORPTION_TIME;
        let offset=0,offsetSpeed=0;
        if(bead.mergeAge<TOTAL_HOP_TIME){
          let start=0;
          for(let hop=0;hop<HOP_DURATIONS.length;hop++){
            const duration=HOP_DURATIONS[hop];
            if(bead.mergeAge<start+duration){
              const phase=(bead.mergeAge-start)/duration,height=bead.mergeRebound*HOP_HEIGHTS[hop];
              offset=height*Math.pow(Math.sin(Math.PI*phase),2);
              offsetSpeed=height*Math.PI/duration*Math.sin(2*Math.PI*phase);break;
            }
            start+=duration;
          }
        }
        const delta=sub(bead.mergeTarget,bead.mergeOrigin);
        bead.position=add(add(bead.mergeOrigin,mul(delta,travel)),mul(bead.mergeNormal,offset));
        bead.velocity=add(mul(delta,derivative),mul(bead.mergeNormal,offsetSpeed));
        bead.link=bead.mergeLink+(1-bead.mergeLink)*smooth(bead.mergeAge/.42);
        bead.radius=bead.mergeRadius*(1-travel);
        if(bead.mergeAge+1e-9>=bead.mergeDuration){emitWave(bead.anchor,.25);bodyImpulse(bead.anchor,.30);beads[index]=null;counters.merged++;}
      }
    }
    for(const bead of beads)if(bead&&(!paused||bead.kind==='interactive'))stepInertia(bead,dt);
  }
  function fillUniforms(){
    beadData.fill(0);linkData.fill(0);styleData.fill(0);waveData.fill(0);waveEnergy.fill(0);fusionData.fill(0);shapeData.fill(0);
    // Stable CPU slots own gestures; dense GPU slots avoid tracing empty manual
    // slots before automatic droplets. Fusion references use the same mapping.
    gpuSlots.fill(-1);gpuBeadCount=0;
    beads.forEach((bead,i)=>{
      if(!bead||bead.radius<=.002)return;
      const slot=gpuBeadCount++;gpuSlots[i]=slot;
      const offset=slot*4;
      for(let axis=0;axis<3;axis++){
        beadData[offset+axis]=bead.position[axis];linkData[offset+axis]=bead.anchor[axis];
      }
      beadData[offset+3]=bead.radius;linkData[offset+3]=bead.link;
      styleData.set(bead.appearance,offset);shapeData.set(dropletShape(bead),offset);
      const factor=stretchFactor(bead),root=Math.sqrt(factor),scale=Math.sqrt(Math.max(0,root-1/factor));
      const axis=bead.inertiaAxis||[1,0,0];
      for(let j=0;j<3;j++)stretchData[offset+j]=axis[j]*scale;
      stretchData[offset+3]=root;
      const extent=bead.radius*1.16*factor;
      let center=bead.position,bound=extent;
      if(bead.link>.002){
        const anchor=mul(bead.anchor,.90);center=mul(add(anchor,bead.position),.5);
        bound=length(sub(anchor,bead.position))*.5+extent+.03;
      }
      if(bead.mode==='coalescing'){
        const target=beads.find(b=>b&&b.id===bead.fusionTarget);
        if(target){center=mul(add(bead.position,target.position),.5);
          bound=length(sub(bead.position,target.position))*.5+Math.max(extent,target.radius*1.16*stretchFactor(target))+.04;}
      }
      for(let j=0;j<3;j++)boundsData[offset+j]=center[j];
      boundsData[offset+3]=bound;
    });
    beads.forEach((bead,i)=>{
      if(!bead||bead.mode!=='coalescing'||gpuSlots[i]<0)return;
      const target=beads.findIndex(b=>b&&b.id===bead.fusionTarget);
      if(target<0||gpuSlots[target]<0)return;
      const blend=smooth(bead.fusionAge/.10);
      const offset=gpuSlots[i]*4;
      fusionData[offset]=gpuSlots[target]+1;fusionData[offset+1]=blend;
      for(let j=0;j<4;j++)styleData[offset+j]=bead.appearance[j]*(1-blend)+beads[target].appearance[j]*blend;
    });
    waves.forEach((wave,i)=>{
      const offset=i*4;waveData.set([...wave.origin,wave.age],offset);waveEnergy[i]=wave.energy;
      waveProfiles[offset]=wave.age*.82;waveProfiles[offset+1]=1/(.20+wave.age*.020);
      waveProfiles[offset+2]=wave.energy*.016*Math.exp(-wave.age*1.30)*smooth(wave.age/.12);
    });
  }

  function updateButton(){
    button.hidden=dead||loading||!ready;
    button.textContent=paused?'播放动画':'暂停动画';
    button.setAttribute('aria-pressed',String(!paused));
    const breathState=(paused||document.hidden||!visible)?'paused':'running';
    poster.style.animationPlayState=breathState;
    if(staticScene)staticScene.style.animationPlayState=breathState;
  }
  const pointerData=new Float32Array(2);
  const framePayload={width:0,height:0,time:0,surfaceTime:0,beadCount:0,viewWindow:viewData,pointer:pointerData,
    bodyShape:bodyShapeData,bodyWarp:bodyWarpData,beads:beadData,beadLinks:linkData,beadStyles:styleData,
    beadFusion:fusionData,beadShape:shapeData,beadStretch:stretchData,beadBounds:boundsData,
    waveOrigins:waveData,waveEnergy,waveProfiles};
  function draw(){
    if(!ready||dead||!renderDriver)return;
    try{
    // Reinvest a little blank margin into detail, within the same pixel budget.
    // Restore the full viewport whenever a droplet approaches a page edge.
    const origin=[pointer.x*.27,.03+pointer.y*.15,4.6],forward=unit(mul(origin,-1));
    const right=unit(cross(forward,[0,1,0])),up=cross(right,forward),shortSide=Math.min(innerWidth,innerHeight);
    const margin=renderCrop===1?.065:.04;
    let reachesEdge=false;
    for(const bead of beads){
      if(!bead||bead.radius<.002)continue;
      const delta=sub(bead.position,origin),depth=dot(delta,forward);
      const extent=bead.radius*1.16*stretchFactor(bead)+.05;
      const factor=shortSide*3.15/(2.82*Math.max(.5,depth));
      const x=innerWidth*.5+dot(delta,right)*factor,y=innerHeight*.5-dot(delta,up)*factor;
      const radius=extent*factor*depth/Math.max(.5,depth-extent)+3;
      if(x+radius<0||x-radius>innerWidth||y+radius<0||y-radius>innerHeight)continue;
      if(x-radius<innerWidth*margin||x+radius>innerWidth*(1-margin)||y-radius<innerHeight*margin||y+radius>innerHeight*(1-margin)){reachesEdge=true;break;}
    }
    const nextCrop=reachesEdge?1:.92;
    if(nextCrop!==renderCrop){renderCrop=nextCrop;resizeNeeded=true;}
    if(resizeNeeded){
      const width=innerWidth*renderCrop,height=innerHeight*renderCrop;
      const ratio=Math.min(devicePixelRatio||1,2,Math.sqrt(settings.maxPixels/(width*height)));
      for(const target of [canvas,renderDriver.canvas]){
        target.style.position='absolute';target.style.left=(innerWidth-width)*.5+'px';target.style.top=(innerHeight-height)*.5+'px';
        target.style.width=width+'px';target.style.height=height+'px';
      }
      renderWidth=Math.max(1,Math.floor(width*ratio));renderHeight=Math.max(1,Math.floor(height*ratio));
      viewData.set([0,0,width/shortSide,height/shortSide]);resizeNeeded=false;
    }
    bodyShapeData.set(shape());bodyWarpData.set(warp());pointerData.set([pointer.x,pointer.y]);fillUniforms();
    framePayload.width=renderWidth;framePayload.height=renderHeight;
    framePayload.time=simTime;framePayload.surfaceTime=surfaceTime;framePayload.beadCount=gpuBeadCount;
    renderDriver.render(framePayload);drawCount++;
    }catch(error){handleRenderError(error);}
  }
  function tick(stamp){
    frame=0;clearTimeout(watchdog);watchdog=0;
    if(!ready||dead||!visible||document.hidden)return;
    if(!lastStamp)lastStamp=stamp;
    const elapsed=stamp-lastStamp;
    if(elapsed>=1000/settings.maxFPS){
      // Ignore background-tab delays; do not catch up missed time.
      const dt=Math.min((lastRenderedStamp?stamp-lastRenderedStamp:elapsed)/1000,.15);
      if(!paused){simTime+=dt;if(flowEnabled)surfaceTime+=dt;}
      stepBody(dt);
      stepBeads(dt);
      lastRenderedStamp=stamp;
      lastStamp=stamp-(elapsed%(1000/settings.maxFPS));
      if(gesture.id===null){
        pointer.x+=(pointer.targetX-pointer.x)*.14;
        pointer.y+=(pointer.targetY-pointer.y)*.14;
      }
      // Keep the same resolution, texture sampling and 24fps target.
      // Worker backpressure bounds queued work without changing visual quality.
      const drawingAt=performance.now();draw();lastDrawMs=performance.now()-drawingAt;
      checkRenderProgress(stamp);
    }
    if(!paused||moving()||Math.abs(pointer.targetX-pointer.x)+Math.abs(pointer.targetY-pointer.y)>.002)
      requestTick();
  }
  function cancelTick(){cancelAnimationFrame(frame);clearTimeout(watchdog);frame=watchdog=0;}
  function requestTick(){
    frame=requestAnimationFrame(tick);
    // Some embedded views stop delivering rAF while still visible. Keep one
    // foreground-only timer as a low-rate safety net, never a second loop.
    watchdog=setTimeout(()=>{cancelAnimationFrame(frame);frame=0;tick(performance.now());},120);
  }
  function schedule(){
    if(!frame&&!watchdog&&ready&&!dead&&visible&&!document.hidden){lastStamp=lastRenderedStamp=0;requestTick();}
  }
  function startupHint(text,limited=false){
    const hint=document.getElementById('drag-hint');
    if(hint){hint.textContent=text;hint.setAttribute('data-limited',String(limited));}
  }
  function resetRenderProgress(){progressFrames=-1;progressAt=0;}
  function checkRenderProgress(stamp){
    if(!ready||dead||paused||!visible||document.hidden){resetRenderProgress();return;}
    const frames=renderDriver.stats.frames;
    if(frames!==progressFrames){
      progressFrames=frames;progressAt=stamp;
      if(renderStalled){renderStalled=false;startupHint(interactionHint);}
    }else if(frames>0&&stamp-progressAt>15000&&!renderStalled){
      renderStalled=true;handleRenderError(new Error('Full-quality rendering stopped producing frames.'));
    }
  }
  function fallback(reason){
    startupRun++;loading=false;lastError=String(reason&&reason.message||reason);
    dead=true;ready=false;interactionReady=false;flowEnabled=false;stage='error';backend='unavailable';
    cancelTick();clearTimeout(presentationTimer);renderDriver?.dispose();renderDriver=null;canvas.hidden=true;
    showStaticFallback();
    startupHint(limitedHint,true);updateButton();
    console.warn('Full-quality water rendering unavailable:',reason);
  }
  function handleRenderError(error){
    if(renderDriver?.backend==='webgl2-worker'&&!recoveringOnMain){
      recoveringOnMain=true;recoveryReason=String(error?.message||error);
      // A worker can compile successfully yet lose its context or fail to
      // present frames. Retry the same material on the ordinary page canvas.
      // Preserve all droplet/gesture state and stop the failed driver first.
      startupRun++;cancelTick();clearTimeout(presentationTimer);renderDriver.dispose();renderDriver=null;
      ready=false;loading=false;dead=false;interactionReady=false;flowEnabled=false;
      canvas.hidden=false;hideStaticFallback();
      void initialize({preferMainThread:true});return;
    }
    fallback(error);
  }
  async function initialize(options={}){
    if(loading)return;
    const run=++startupRun;initializingAt=performance.now();startupTimings={};
    loading=true;dead=false;lastError='';enhancementError='';stage='loading-gpu';
    resetRenderProgress();renderStalled=false;
    startupHint('正在加载完整水球…');updateButton();
    hideStaticFallback();canvas.hidden=false;
    if(!gpuAssets)gpuAssets={
      vertex:document.getElementById('vertex').textContent.trim(),fragment:document.getElementById('fragment').textContent.trim(),
      antialias:document.getElementById('fragment-aa').textContent.trim(),
      normals:'data:image/webp;base64,'+document.getElementById('normal-atlas').textContent.trim(),
      environment:'data:image/png;base64,'+document.getElementById('environment-atlas').textContent.trim()
    };
    try{
      const candidate=await window.createWaterRenderDriver(canvas,gpuAssets,error=>{if(run===startupRun)handleRenderError(error);},{preferMainThread:recoveringOnMain,...options});
      if(run!==startupRun){candidate.dispose();return;}
      renderDriver=candidate;backend=candidate.backend;resizeNeeded=true;
      startupTimings={...candidate.timings,interactiveAtMs:performance.now()-initializingAt};
      dead=false;ready=true;interactionReady=true;flowEnabled=true;stage='interactive';loading=false;
      canvas.hidden=false;canvas.style.opacity=backend==='webgl2'?'1':'0';
      candidate.setActive(visible&&!document.hidden);
      if(!paused)emitWave([-.25,.35,1],.30);
      draw();
      if(run!==startupRun)return;
      const reveal=()=>{if(run===startupRun){
        hideStaticFallback();poster.removeAttribute?.('src');startupHint(interactionHint);
      }};
      if(candidate.firstFrame){
        let elapsed=0,last=performance.now();
        const checkPresentation=()=>{
          if(run!==startupRun)return;
          const now=performance.now();if(visible&&!document.hidden)elapsed+=Math.min(1500,now-last);last=now;
          if(elapsed>=15000)handleRenderError(new Error('Full-quality GPU first frame timed out.'));
          else presentationTimer=setTimeout(checkPresentation,1000);
        };
        presentationTimer=setTimeout(checkPresentation,1000);
        candidate.firstFrame.then(()=>{if(run===startupRun){clearTimeout(presentationTimer);reveal();}});
      }else reveal();
      updateButton();schedule();
    }catch(error){if(run===startupRun)handleRenderError(error);}
  }
  button.addEventListener('click',()=>{
    paused=!paused;updateButton();schedule();
  });
  function dropletIntersection(bead,ray){
    const delta=sub(ray.origin,bead.position),d=ray.direction,r=bead.radius;
    const center=-dot(delta,d),o=undoStretch(mul(add(delta,mul(d,center)),1/r),bead),v=undoStretch(mul(d,1/r),bead);
    const bound=r*r*1.44*stretchFactor(bead)**2-dot(add(delta,mul(d,center)),add(delta,mul(d,center)));
    if(bound<0)return Infinity;
    const [sx,sy,sz,bend]=dropletShape(bead),reach=Math.sqrt(bound);
    const a=-bend*v[1]*v[1]/sx,b=(v[0]-2*bend*o[1]*v[1])/sx;
    const c=(o[0]-bend*(o[1]*o[1]-.30))/sx;
    const y=o[1]/sy,vy=v[1]/sy,z=o[2]/sz,vz=v[2]/sz;
    const f=t=>((a*t+b)*t+c)**2+(y+vy*t)**2+(z+vz*t)**2-1;
    const slope=t=>((a*t+b)*t+c)*(2*a*t+b)+(y+vy*t)*vy+(z+vz*t)*vz;
    let lo=-reach,hi=reach;
    for(let i=0;i<28;i++){const t=(lo+hi)*.5;if(slope(t)>0)hi=t;else lo=t;}
    const closest=(lo+hi)*.5;if(f(closest)>0)return Infinity;
    lo=-reach;hi=closest;
    for(let i=0;i<28;i++){const t=(lo+hi)*.5;if(f(t)>0)lo=t;else hi=t;}
    return center+(lo+hi)*.5;
  }
  function beadUnderPointer(point){
    const ray=cameraRay(point),main=mainIntersection(point);
    const mainDepth=main.hit?main.near:Infinity;
    let nearest=mainDepth,index=-1;
    beads.forEach((bead,i)=>{
      if(!bead||bead.mode==='merging'||bead.mode==='dissolving'||bead.mode==='coalescing'||bead.radius<.015)return;
      const t=dropletIntersection(bead,ray);
      if(t>0&&t<nearest){nearest=t;index=i;}
    });
    return index;
  }
  function moveGesture(point){
    if(gesture.mode==='armed'){
      const bead=beads[gesture.bead];if(!bead)return;
      if(length(sub(worldPoint(point),bead.dragStart))>.001)bead.dragMoved=true;
      const destination=dragPosition(bead,point);
      if(mainIntersection(point).hit){bead.position=destination;gesture.last=point;return;}
      const anchor=boundaryBetween(gesture.last,point);
      bead.anchor=anchor;bead.mode='attached';bead.link=1;
      bead.dragSample=[...bead.position];
      gesture.mode='bead';counters.emerged++;
      emitWave(anchor,.13+bead.radius);
    }
    if(gesture.mode!=='bead')return;
    const bead=beads[gesture.bead];if(!bead)return;
    bead.dragTarget=dragPosition(bead,point);bead.lastPointTime=performance.now();
    bead.dragReenter=mainIntersection(point).hit;
    gesture.last=point;
  }
  addEventListener('pointermove',event=>{
    if(gesture.id!==null){
      if(event.pointerId!==gesture.id)return;
      const samples=typeof event.getCoalescedEvents==='function'?event.getCoalescedEvents():[];
      // Preserve curved pointer paths: the last inside sample determines the exit segment.
      for(const sample of samples.length?samples:[event])moveGesture({x:sample.clientX,y:sample.clientY});
      schedule();return;
    }
    if(!reduced.matches){
      pointer.targetX=clamp((event.clientX/innerWidth-.5)*2,-1,1);
      pointer.targetY=clamp((.5-event.clientY/innerHeight)*2,-1,1);schedule();
    }
  },{passive:true});
  canvas.style.touchAction='none';
  canvas.addEventListener('pointerdown',event=>{
    if(!ready||dead||gesture.id!==null||event.button!==0)return;
    const point={x:event.clientX,y:event.clientY};let index=beadUnderPointer(point);
    if(index>=MANUAL_BEADS){
      const slot=beads.findIndex((bead,i)=>i<MANUAL_BEADS&&!bead);
      if(slot<0)return;
      beads[slot]=beads[index];beads[index]=null;index=slot;beads[index].kind='interactive';
    }
    const mainHit=index<0?mainIntersection(point):null;
    if(index<0&&!mainHit.hit)return;
    const bornInside=index<0;
    if(bornInside){
      // Use the near visible surface, not the drag plane or the silhouette anchor.
      // Emit before the capacity check so clicking a full main sphere still responds.
      emitWave(add(mainHit.origin,mul(mainHit.direction,mainHit.near)),.94);counters.clicks++;
      event.preventDefault();draw();schedule();
      if(!interactionReady)return;
      index=beads.findIndex((bead,i)=>i<MANUAL_BEADS&&!bead);
      if(index<0){counters.capacityHits++;return;}
      const radius=randomRadius(),start=worldPoint(point),center=safelyInside(start,radius*1.16);
      const bead=newBead('interactive',center,radius,surfaceAt(center),'internal');
      bead.radius=0;bead.growAge=0;bead.dragStart=start;bead.dragOffset=sub(start,center);
      bead.lastPointTime=performance.now();beads[index]=bead;counters.created++;
    }
    event.preventDefault();gesture.id=event.pointerId;gesture.last=point;
    gesture.bead=index;gesture.mode=bornInside?'armed':'bead';
    if(!bornInside){
      const bead=beads[index];
      if(bead.mode==='ambient')bead.mode='detached';
      if(bead.mode==='homing')bead.mode='detached';
      if(bead.mode==='returning')bead.mode='attached';
      bead.lastPointTime=performance.now();
      bead.dragOffset=null;bead.dragStart=null;
      bead.grabOffset=sub(worldPoint(point),bead.position);
      bead.dragTarget=[...bead.position];bead.dragSample=[...bead.position];bead.dragReenter=false;
    }
    pointer.targetX=pointer.x;pointer.targetY=pointer.y;
    try{canvas.setPointerCapture(event.pointerId);}catch(_){/* Window-level release remains available. */}
    canvas.style.cursor='grabbing';schedule();
  });
  function release(event={}){
    if(gesture.id===null||(event.pointerId!==undefined&&event.pointerId!==gesture.id))return;
    const id=gesture.id,bead=beads[gesture.bead];
    gesture.id=null;gesture.mode='idle';gesture.bead=-1;gesture.last=null;
    if(bead){
      bead.dragTarget=null;bead.dragSample=null;bead.dragReenter=false;
      if(bead.mode==='internal'||(bead.mode==='attached'&&mainGap(bead.position)<-bead.baseRadius*1.16)){
        dissolveInternal(bead);
      }else if(bead.mode==='attached'){
        bead.mode='returning';bead.velocity=mul(bead.velocity,.45);
        emitWave(bead.anchor,.2+Math.min(.7,length(sub(bead.position,bead.anchor))));
      }else if(bead.mode==='detached'||bead.mode==='pinching'){
        // Detached beads retain a little hand momentum, then accelerate gently home.
        bead.velocity=mul(bead.velocity,.28);
        if(bead.mode==='detached')bead.mode='homing';
        if(mainGap(bead.position)<bead.baseRadius*.70)startMerge(bead);
      }
    }
    try{if(canvas.hasPointerCapture(id))canvas.releasePointerCapture(id);}catch(_){}
    canvas.style.cursor='grab';schedule();
  }
  canvas.addEventListener('pointerup',release);
  canvas.addEventListener('pointercancel',release);
  canvas.addEventListener('lostpointercapture',release);
  addEventListener('pointerup',release);
  addEventListener('pointercancel',release);
  addEventListener('blur',release);
  document.addEventListener('pointerleave',()=>{if(gesture.id===null){pointer.targetX=pointer.targetY=0;schedule();}});
  let resizeTimer;
  addEventListener('resize',()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>{resizeNeeded=true;draw();schedule();},150);});
  document.addEventListener('visibilitychange',()=>{
    if(document.hidden)release({});
    resetRenderProgress();
    renderDriver?.setActive(visible&&!document.hidden);
    updateButton();
    if(document.hidden){cancelTick();}
    else {lastStamp=lastRenderedStamp=0;schedule();}
  });
  if('IntersectionObserver'in window)new IntersectionObserver(entries=>{
    visible=entries[0].isIntersecting;
    resetRenderProgress();
    renderDriver?.setActive(visible&&!document.hidden);
    updateButton();
    if(!visible){cancelTick();}else schedule();
  }).observe(document.documentElement);
  function restoreForeground(){
    if(document.hidden)return;
    // Embedded panels may be recreated or shown from a back/forward cache
    // without delivering their usual visibility/IntersectionObserver update.
    const rect=canvas.getBoundingClientRect();
    visible=rect.width>0&&rect.height>0&&rect.left<innerWidth&&rect.top<innerHeight&&
      rect.left+rect.width>0&&rect.top+rect.height>0;
    renderDriver?.setActive(visible);
    updateButton();
    resetRenderProgress();lastStamp=lastRenderedStamp=0;resizeNeeded=true;schedule();
  }
  addEventListener('pageshow',restoreForeground);
  addEventListener('focus',restoreForeground);
  canvas.addEventListener('webglcontextrestored',()=>{if(dead)void initialize();});
  window.waterBall={settings,
    pause(){paused=true;updateButton();},
    resume(){paused=false;updateButton();schedule();},
    setTime(value){const t=Number(value);if(Number.isFinite(t)){simTime=t;surfaceTime=t;}draw();},
    render:draw,
    get state(){return{ready,paused,fallback:dead,loading,lastError,drawCount,lastDrawMs,backend,recoveryReason,staticFallback:dead,renderedFrames:renderDriver?.stats.frames||0,
      stage,interactionReady,flowEnabled,surfaceTime,enhancementError,startupTimings:{...startupTimings},gpuBeadCount,time:simTime,width:renderWidth,height:renderHeight,renderCrop,
      capacity:{interactive:MANUAL_BEADS,ambient:MAX_BEADS-MANUAL_BEADS},gesture:{...gesture},counters:{...counters},
      camera:{pointer:[pointer.x,pointer.y],shape:shape(),warp:warp()},
      body:{shape:shape(),warp:warp(),modes:[...body.modes],velocity:[...body.velocity],target:[...body.target],impulses:body.impulses},
      beads:beads.map((b,index)=>b?{index,id:b.id,kind:b.kind,mode:b.mode,position:[...b.position],velocity:[...b.velocity],
        radius:b.radius,baseRadius:b.baseRadius,anchor:[...b.anchor],link:b.link,detachLimit:b.detachLimit,appearance:[...b.appearance],
        mergeAge:b.mergeAge,recontacts:b.mergeTouchdowns||0,
        fusionTarget:b.fusionTarget||null,fusionAge:b.fusionAge||0,shape:dropletShape(b),stretch:[...(b.inertiaAxis||[1,0,0]),b.inertiaAmount||0],
        dragTarget:b.dragTarget?[...b.dragTarget]:null}:null),
      waves:waves.map(w=>({origin:[...w.origin],age:w.age,energy:w.energy}))};},
    async savePNG(){if(!ready)return;draw();const blob=await renderDriver.capture();if(!blob)return;const url=URL.createObjectURL(blob),a=document.createElement('a');a.download='water-ball.png';a.href=url;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  };
  updateButton();
  setTimeout(initialize,0);
})();
