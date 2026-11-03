#version 300 es
precision highp float;
uniform vec2 resolution;
uniform vec4 viewWindow;
uniform sampler2D normalAtlas;
uniform samplerCube environmentMap;
uniform float time;
uniform float surfaceTime;
uniform int surfaceClockEnabled;
uniform vec2 pointer;
uniform vec3 bodyShape; // CPU-resolved axes; zero preserves the time-only fallback.
uniform vec2 bodyWarp;  // CPU-resolved quadratic bend and linear shear.
uniform vec4 beads[8];
uniform vec4 beadLinks[8];
uniform vec4 beadStyles[8];
uniform vec4 beadFusion[8]; // Explicit donor -> held bead, plus neck formation.
uniform vec4 beadShape[8]; // Volume-preserving axes and an asymmetric bend.
uniform vec4 beadStretch[8]; // Precomputed inverse volume-preserving stretch.
uniform vec4 beadBounds[8]; // Frame-constant bounds resolved once on CPU.
uniform int beadCount; // Runtime loop bound prevents large nested compiler unrolling.
uniform vec4 waveOrigins[4];
uniform vec4 waveEnergy;
uniform vec4 waveProfiles[4]; // CPU-resolved radius, inverse width, decayed energy.
out vec4 fragColor;
const float IOR=1.333;
vec3 SHAPE;
vec2 WARP;
bool hasWaves;
int liveBeads;
float dropletMaterial;
float dropletSeed;
float dropletRadius;
float pixelWorld;
float sq(float x){return x*x;}
float fourth(float x){return x*x*x*x;}
float smoothUnion(float a,float b,float k){
  float h=clamp(.5+.5*(b-a)/k,0.,1.);
  return mix(b,a,h)-k*h*(1.-h);
}
float waveHeight(vec3 p){
  if(!hasWaves)return 0.;
  vec3 unit=normalize(p);
  float height=0.;
  for(int j=0;j<4;j++){
    vec4 wave=waveOrigins[j];
    float energy=waveEnergy[j];
    if(energy<.001||wave.w>3.4)continue;
    vec4 profile=waveProfiles[j];
    float phase=length(unit-wave.xyz)-profile.x;
    float envelope=exp(-sq(phase*profile.y));
    // A traveling crest with trailing troughs makes expanding, concentric ripples.
    height+=profile.z*sin(phase*27.)*envelope;
  }
  // Multiple simultaneous taps remain bounded inside the existing march envelope.
  return height*.035/(.035+abs(height));
}
vec3 bodyLocal(vec3 p){
  p.x-=WARP.x*(p.y*p.y-.30)+WARP.y*p.y;
  return p/SHAPE;
}
vec3 bodyNormal(vec3 p){
  vec3 q=bodyLocal(p)/SHAPE;
  return normalize(vec3(q.x,q.y-q.x*(2.*WARP.x*p.y+WARP.y),q.z));
}
float mainField(vec3 p){
  float base=length(bodyLocal(p))-1.;
  // Surface-only ripples need no evaluation while marching through empty space
  // or the deep interior. The fade is outside all possible zero crossings.
  if(!hasWaves||abs(base)>.075)return base;
  return base-waveHeight(p)*(1.-smoothstep(.045,.075,abs(base)));
}
float beadField(vec3 p,int i){
  vec4 shape=beadShape[i].x>.5?beadShape[i]:vec4(1.,1.,1.,0.);
  float radius=max(beads[i].w,.00001);
  vec3 local=(p-beads[i].xyz)/radius;
  vec4 stretch=beadStretch[i].w>.5?beadStretch[i]:vec4(0.,0.,0.,1.);
  local=local*stretch.w-stretch.xyz*dot(stretch.xyz,local);
  local.x-=shape.w*(local.y*local.y-.30);
  // Conservative distance scale keeps the ray march stable on bent surfaces.
  return (length(local/shape.xyz)-1.)*radius*.82/stretch.w;
}
float field(vec3 p){
  float mainValue=mainField(p),value=mainValue;
  if(liveBeads==0)return value;
  for(int i=0;i<beadCount;i++){
    vec4 bead=beads[i];
    if(bead.w<.002)continue;
    if(length(p-beadBounds[i].xyz)-beadBounds[i].w>value+.16)continue;
    float ball=beadField(p,i);
    if(beadLinks[i].w>.002){
      vec3 anchor=beadLinks[i].xyz*.90,segment=bead.xyz-anchor;
      float along=clamp(dot(p-anchor,segment)/max(dot(segment,segment),.001),0.,1.);
      vec3 side=vec3(-beadLinks[i].y,beadLinks[i].x,0.);
      float bend=sin(along*3.14159)*.009*sin(time*2.+along*4.);
      float pinch=smoothstep(.15,.65,length(bead.xyz)-1.);
      float radius=bead.w*mix(.42,.15,pinch)*beadLinks[i].w;
      float waist=along*2.-1.;
      float neck=length(p-anchor-segment*along-side*bend)-radius*(.60+.65*waist*waist);
      ball=smoothUnion(ball,neck,.05*beadLinks[i].w);
    }
    if(beadFusion[i].x>.5){
      int partner=int(beadFusion[i].x)-1;
      float neck=max(.0001,min(bead.w,beads[partner].w)*.75*beadFusion[i].y);
      ball=smoothUnion(ball,beadField(p,partner),neck);
      vec3 segment=beads[partner].xyz-bead.xyz;
      float along=clamp(dot(p-bead.xyz,segment)/max(dot(segment,segment),.00001),0.,1.);
      float thread=length(p-bead.xyz-segment*along)-min(bead.w,beads[partner].w)*.34*beadFusion[i].y;
      ball=smoothUnion(ball,thread,neck*.35);
    }
    // Keep the blend width continuous when a neck starts or breaks.
    // Each bead blends with the main sphere, never with another free bead.
    value=min(value,smoothUnion(mainValue,ball,.10+.035*beadLinks[i].w));
  }
  return value;
}
vec3 geometricNormal(vec3 p){
  if(!hasWaves){
    bool nearBead=false;
    for(int i=0;i<beadCount;i++){
      if(beads[i].w>.002&&length(p-beadBounds[i].xyz)<beadBounds[i].w+.14){nearBead=true;break;}
    }
    if(!nearBead)return bodyNormal(p);
  }
  // Four tetrahedral samples replace six central differences; identical field.
  const vec2 e=vec2(.0014,-.0014);
  return normalize(e.xyy*field(p+e.xyy)+e.yyx*field(p+e.yyx)+e.yxy*field(p+e.yxy)+e.xxx*field(p+e.xxx));
}
vec2 sphere(vec3 origin,vec3 direction,vec3 center,float radius){
  vec3 o=origin-center;
  float b=dot(o,direction),h=b*b-dot(o,o)+radius*radius;
  if(h<0.)return vec2(-1.);
  return vec2(-b-sqrt(h),-b+sqrt(h));
}
vec2 bounds(vec3 ro,vec3 rd){
  vec2 hit=sphere(ro,rd,vec3(0.),1.28);
  float start=hit.x>0.?hit.x:1e5,end=max(0.,hit.y);
  for(int i=0;i<beadCount;i++){
    if(beads[i].w<.002)continue;
    vec2 h=sphere(ro,rd,beadBounds[i].xyz,beadBounds[i].w+.16);
    if(h.x>0.){start=min(start,h.x);end=max(end,h.y);}
  }
  return start>1e4?vec2(-1.):vec2(start,end);
}
vec3 normalDetail(vec3 local,float phase,float motion,float radius){
  float opticalTime=surfaceClockEnabled==1?surfaceTime:time;
  vec3 unit=normalize(local);
  // Two crossing currents advect different latitudes at different rates.
  // The same single atlas lookup now stretches and changes the pattern locally.
  float a=sin(unit.y*4.8+unit.z*2.1+opticalTime*.62+phase);
  float b=sin(unit.x*4.1-unit.z*3.2-opticalTime*.48+phase*.7);
  vec3 current=vec3(a,b,(a-b)*.5);
  current-=unit*dot(current,unit);
  vec3 advected=normalize(unit+current*(.075*motion));
  float flow=opticalTime*.095+phase;
  float c=cos(flow),s=sin(flow);
  vec3 rotated=vec3(c*advected.x-s*advected.z,advected.y,s*advected.x+c*advected.z);
  vec2 uv=vec2(atan(rotated.z,rotated.x)/6.2831853+.5,asin(clamp(rotated.y,-1.,1.))/3.14159265+.5);
  // Explicit footprint avoids undefined implicit derivatives inside divergent
  // ray-march branches. Small drops sample their matching prefiltered level.
  float footprint=pixelWorld*326./(max(radius,.012)*max(.30,length(rotated.xz)));
  vec3 n=textureLod(normalAtlas,uv,max(0.,log2(footprint))).rgb*2.-1.;
  n=vec3(c*n.x+s*n.z,n.y,-s*n.x+c*n.z);
  return n-advected;
}
vec3 waterNormal(vec3 p,vec3 base){
  dropletMaterial=0.;
  dropletSeed=0.;
  dropletRadius=1.;
  // Surface waves also carry/stretch the optical texture around their moving crest.
  vec3 mainLocal=bodyLocal(p)+(base-bodyNormal(p))*.12;
  if(liveBeads==0)return normalize(base+normalDetail(mainLocal,0.,1.,1.));
  float mainDistance=mainField(p),distance=1e5;
  int owner=-1;
  for(int i=0;i<beadCount;i++){
    if(beads[i].w<.002)continue;
    if(length(p-beads[i].xyz)-beads[i].w>mainDistance+.16)continue;
    float d=beadField(p,i);
    if(d<distance){distance=d;owner=i;}
  }
  float blend=owner<0?0.:smoothstep(-.12,.12,mainDistance-distance);
  dropletMaterial=blend;
  if(owner>=0){dropletSeed=beadStyles[owner].w;dropletRadius=beads[owner].w;}
  vec3 delta=vec3(0.);
  if(blend<.999)delta=normalDetail(mainLocal,0.,1.,1.)*(1.-blend);
  if(owner>=0&&blend>.001){
    vec3 local=(p-beads[owner].xyz)/max(beads[owner].w,.002);
    vec4 stretch=beadStretch[owner].w>.5?beadStretch[owner]:vec4(0.,0.,0.,1.);
    local=local*stretch.w-stretch.xyz*dot(stretch.xyz,local);
    vec4 shape=beadShape[owner].x>.5?beadShape[owner]:vec4(1.,1.,1.,0.);
    local.x-=shape.w*(local.y*local.y-.30);local/=shape.xyz;
    float strength=.68+.18*beadStyles[owner].z;
    delta+=normalDetail(local,beadStyles[owner].w*6.283,.65,beads[owner].w)*strength*blend;
  }
  // The same flowing normal atlas shades both volumes; smaller droplets have
  // a gentler optical surface while their geometric silhouette stays round.
  return normalize(base+delta);
}
float fresnel(float c){return .02037+.97963*pow(1.-clamp(c,0.,1.),5.);}
vec3 studio(vec3 d){
  // Static studio lighting is baked once; reflection/refraction directions stay live.
  vec3 encoded=textureLod(environmentMap,d,.65).rgb;
  return encoded*encoded*8.;
}
vec3 backgroundAt(vec3 origin,vec3 direction){
  return vec3(1.);
}
vec3 transmitted(vec3 p,vec3 rd,vec3 n,vec3 gn){
  vec3 entryNormal=normalize(mix(gn,n,.94));
  vec3 internal=refract(rd,entryNormal,1./IOR);
  vec3 start=p+internal*.004;
  float distance=.003;
  for(int i=0;i<36;i++){
    float d=field(start+internal*distance);
    if(d>.0006)break;
    distance+=max(abs(d)*.82,.003);
    if(distance>3.)break;
  }
  vec3 back=start+internal*distance;
  vec3 bgn=geometricNormal(back);
  vec3 bn=normalize(mix(bgn,waterNormal(back,bgn),.94));
  vec3 ray=refract(internal,-bn,IOR);
  vec3 reflected=reflect(internal,bn);
  vec3 result;
  float f=fresnel(dot(internal,bn));
  if(dot(ray,ray)<.01){result=studio(reflected);f=0.;}
  else result=mix(studio(ray),backgroundAt(back,ray),.14);
  result=mix(result,studio(reflected),f*.55);
  return result*exp(-vec3(.15,.027,.005)*max(distance,0.));
}
vec3 waterDroplet(vec3 rd,vec3 gn,vec3 n,float seed,float radius){
  // Reuse the main water's illumination and refraction. An analytic back
  // interface keeps small droplets cheap while retaining the same material.
  float facing=clamp(-dot(rd,gn),0.,1.);
  vec3 internal=refract(rd,normalize(mix(gn,n,.84)),1./IOR);
  float thickness=max(.0,-2.*dot(gn,internal));
  vec3 back=normalize(gn+internal*thickness);
  vec3 bn=normalize(back+normalDetail(back,seed*6.283,.65,radius)*(1.15*smoothstep(.08,.35,facing)));
  vec3 exitRay=refract(internal,-bn,IOR);
  bool totalReflection=dot(exitRay,exitRay)<.01;
  if(totalReflection)exitRay=reflect(internal,bn);
  vec3 transmittedColor=mix(studio(exitRay),vec3(.79,.96,1.04),.34);
  transmittedColor*=exp(-vec3(.11,.025,.005)*thickness*.55);
  vec3 reflected=reflect(rd,n);
  vec3 reflectedColor=mix(studio(reflected),vec3(.79,.96,1.04),.25);
  float f=fresnel(clamp(-dot(rd,n),0.,1.));
  vec3 color=mix(transmittedColor,reflectedColor,f);
  color+=vec3(1.4)*pow(max(dot(reflected,normalize(vec3(-.55,.72,1.1))),0.),190.);
  return color;
}
void main(){
  SHAPE=bodyShape.x>.5?bodyShape:vec3(1.+.009*sin(time*.7),1.035+.012*sin(time*.7),.99);
  WARP=bodyShape.x>.5?bodyWarp:vec2(.10+.018*sin(time*.42),.035*sin(time*.31+.6));
  hasWaves=dot(waveEnergy,vec4(1.))>.001;
  liveBeads=beadCount;
  pixelWorld=4.1*(viewWindow.w>0.?viewWindow.w/resolution.y:1./min(resolution.x,resolution.y));
  vec2 uv=(gl_FragCoord.xy-.5*resolution)/min(resolution.x,resolution.y);
  if(viewWindow.z>0.)uv=(gl_FragCoord.xy/resolution-.5)*viewWindow.zw+viewWindow.xy;
  vec3 ro=vec3(pointer.x*.27,.03+pointer.y*.15,4.6);
  vec3 forward=normalize(-ro),right=normalize(cross(forward,vec3(0.,1.,0.))),up=cross(right,forward);
  vec3 rd=normalize(forward*3.15+right*uv.x*2.82+up*uv.y*2.82);
  vec3 background=backgroundAt(ro,rd);
  float shadow=exp(-sq(uv.x/.175)-sq((uv.y+.285)/.023));
  background=mix(background,vec3(.46,.66,.83),shadow*.11);
  vec2 interval=bounds(ro,rd);
  float t=interval.x;
  bool hit=false;
  if(t>0.){
    for(int i=0;i<56;i++){
      float d=field(ro+rd*t);
      if(d<.00065){hit=true;break;}
      t+=max(d*.78,.0004);
      if(t>interval.y)break;
    }
  }
  if(!hit){fragColor=vec4(pow(background,vec3(1./2.2)),1.);return;}
  vec3 p=ro+rd*t,gn=geometricNormal(p),n=waterNormal(p,gn);
  float clearDrop=dropletMaterial,seed=dropletSeed,clearRadius=dropletRadius;
  float facing=clamp(-dot(rd,gn),0.,1.);
  n=normalize(mix(gn,n,smoothstep(.0,.19,facing)));
  vec3 color=vec3(0.);
  if(clearDrop<.999){
    vec3 reflected=reflect(rd,n);
    color=mix(transmitted(p,rd,n,gn),studio(reflected),fresnel(-dot(rd,n)));
    color+=vec3(1.4)*pow(max(dot(reflected,normalize(vec3(-.55,.72,1.1))),0.),190.);
  }
  if(clearDrop>.001)color=mix(color,waterDroplet(rd,gn,n,seed,clearRadius),clearDrop);
  color=pow(max(color,vec3(0.)),vec3(1./2.2));
  fragColor=vec4(clamp(color,0.,1.),1.);
}
