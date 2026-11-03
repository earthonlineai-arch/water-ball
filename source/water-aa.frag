#version 300 es
precision highp float;
uniform sampler2D scene;
uniform vec2 resolution;
out vec4 fragColor;
float luminance(vec3 rgb){return dot(rgb,vec3(.299,.587,.114));}
void main(){
  vec2 pixel=1./resolution,uv=gl_FragCoord.xy*pixel;
  vec3 center=texture(scene,uv).rgb;
  vec3 nw=texture(scene,uv+vec2(-1.,1.)*pixel).rgb;
  vec3 ne=texture(scene,uv+pixel).rgb;
  vec3 sw=texture(scene,uv-pixel).rgb;
  vec3 se=texture(scene,uv+vec2(1.,-1.)*pixel).rgb;
  float m=luminance(center),a=luminance(nw),b=luminance(ne),c=luminance(sw),d=luminance(se);
  float low=min(m,min(min(a,b),min(c,d))),high=max(m,max(max(a,b),max(c,d)));
  if(high-low<max(.035,high*.14)){fragColor=vec4(center,1.);return;}
  vec2 direction=vec2(-(a+b-c-d),a+c-b-d);
  float reduce=max((a+b+c+d)*.03125,.0078125);
  direction=clamp(direction/(min(abs(direction.x),abs(direction.y))+reduce),vec2(-4.),vec2(4.))*pixel;
  vec3 inner=.5*(texture(scene,uv-direction/6.).rgb+texture(scene,uv+direction/6.).rgb);
  vec3 outer=inner*.5+.25*(texture(scene,uv-direction*.5).rgb+texture(scene,uv+direction*.5).rgb);
  float value=luminance(outer);
  fragColor=vec4(value<low||value>high?inner:outer,1.);
}
