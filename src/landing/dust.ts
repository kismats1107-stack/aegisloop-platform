// Procedural dust/fog layer (WebGL2, one fullscreen triangle). S = surge 0..1 driven by scroll.
const VS = `#version 300 es
void main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);gl_Position=vec4(p*2.-1.,0,1);}`;
const FS = `#version 300 es
precision highp float;
uniform vec2 R;uniform float T,S;out vec4 O;
float h(vec2 p){p=fract(p*vec2(123.34,456.21));p+=dot(p,p+45.32);return fract(p.x*p.y);}
float n(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);
  return mix(mix(h(i),h(i+vec2(1,0)),f.x),mix(h(i+vec2(0,1)),h(i+vec2(1,1)),f.x),f.y);}
float fbm(vec2 p){float a=.5,s=0.;mat2 m=mat2(1.6,1.2,-1.2,1.6);p=mat2(.8,.6,-.6,.8)*p+5.3;for(int i=0;i<5;i++){s+=a*n(p);p=m*p;a*=.5;}return s;}
void main(){
  vec2 uv=gl_FragCoord.xy/R;uv.y=1.-uv.y;
  vec2 p=vec2(uv.x*R.x/R.y,uv.y);
  float t=T*.06;
  vec2 w=vec2(fbm(p*1.3+vec2(t,-t*.6)),fbm(p*1.3+vec2(-t*.8,t)+7.));
  float d=fbm(p*1.9+w*1.7+vec2(t*1.6,-t*1.1+S*.8));
  float front=1.05-S*1.1;
  float rise=smoothstep(front-.05,front+.3,uv.y+(d-.5)*.6);
  float haze=S*(.25+.6*d);
  float edge=smoothstep(.72,1.06,uv.y+(d-.5)*.3)*.35;
  float a=clamp(max(max(rise*.98*S,haze),edge*S),0.,1.);
  vec3 c=mix(vec3(.62,.58,.52),vec3(.92,.89,.83),d*1.1);
  O=vec4(c*a,a);
}`;

export function createDust(canvas: HTMLCanvasElement) {
  const gl = canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: true, antialias: false });
  if (!gl) return { render: () => {}, dispose: () => {} };
  const sh = (type: number, src: string) => { const s = gl.createShader(type)!; gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.error("dust shader:", gl.getShaderInfoLog(s)); return s; };
  const pr = gl.createProgram()!; gl.attachShader(pr, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(pr); gl.useProgram(pr);
  const U = { R: gl.getUniformLocation(pr, "R"), T: gl.getUniformLocation(pr, "T"), S: gl.getUniformLocation(pr, "S") };
  let idle = false;
  return {
    render(time: number, surge: number) {
      const w = Math.round(Math.min(canvas.clientWidth, 460)), h = Math.round((w * canvas.clientHeight) / Math.max(1, canvas.clientWidth));
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; gl.viewport(0, 0, w, h); }
      if (surge <= 0.001) { if (!idle) { gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); idle = true; } return; }
      idle = false;
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform2f(U.R, w, h); gl.uniform1f(U.T, time / 1000); gl.uniform1f(U.S, surge);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
    dispose() { gl.deleteProgram(pr); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); },
  };
}
