"use client";

import { useEffect, useRef } from "react";
import { motionState } from "@/lib/motion-state.ts";

const VERTEX = "attribute vec2 p;varying vec2 v;void main(){v=p*.5+.5;gl_Position=vec4(p,0.,1.);}";
const FRAGMENT = `precision highp float;varying vec2 v;uniform sampler2D T;uniform vec2 R,I,M,MV;uniform float t,S,Rv;
float h(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float n(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(h(i),h(i+vec2(1,0)),f.x),mix(h(i+vec2(0,1)),h(i+vec2(1,1)),f.x),f.y);}
void main(){float sc=max(R.x/I.x,R.y/I.y);vec2 uv=(v-.5)*R/(I*sc)+.5;uv.y=1.-uv.y;float a=1.-Rv;
vec2 f=vec2(n(uv*3.+t*.06),n(uv*3.+9.-t*.05))-.5;vec2 d=(v-M)*vec2(R.x/R.y,1.);float m=exp(-dot(d,d)*16.);
vec2 dir=vec2(.12*a,S*.14)+MV*m*.9;vec2 o=f*(.012+.07*a)+MV*m*.25;vec3 c=vec3(0.);
for(int i=0;i<10;i++){float k=float(i)/9.-.5;c+=texture2D(T,uv+o+dir*k).rgb;}c/=10.;
float r=texture2D(T,uv+o+dir*.62).r;c.r=mix(c.r,r,.5*clamp(a+abs(S)+length(MV)*m*2.,0.,1.));
c+=(h(v*R+t)-.5)*.045;gl_FragColor=vec4(c,1.);}`;

/**
 * 首屏涂抹着色器：载入后从重度涂抹浮现；鼠标划过推开颜料；滚动越快涂抹越重。
 * 仅用于首页首屏（见 UI_DESIGN_SYSTEM.md §6）。不支持 WebGL 时保持下方的静态 <img>。
 */
export function HeroCanvas({ src }: { src: string }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const gl = canvas.getContext("webgl", { antialias: false, alpha: false });
    if (!gl) return;

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) motionState.reveal = 1;

    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type);
      if (!shader) return null;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      return shader;
    };
    const vertex = compile(gl.VERTEX_SHADER, VERTEX);
    const fragment = compile(gl.FRAGMENT_SHADER, FRAGMENT);
    const program = gl.createProgram();
    if (!vertex || !fragment || !program) return;
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return;
    gl.useProgram(program);

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, "p");
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    const uniform = (name: string) => gl.getUniformLocation(program, name);
    const U = { T: uniform("T"), R: uniform("R"), I: uniform("I"), M: uniform("M"), MV: uniform("MV"), t: uniform("t"), S: uniform("S"), Rv: uniform("Rv") };

    const texture = gl.createTexture();
    const mouse = { x: 0.5, y: 0.5, tx: 0.5, ty: 0.5, vx: 0, vy: 0 };
    let imageWidth = 1;
    let imageHeight = 1;
    let ready = false;
    let visible = true;
    let frame = 0;
    const start = performance.now();
    const clamp = (value: number) => Math.max(-1.5, Math.min(1.5, value));

    const draw = () => {
      if (!ready) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.round(canvas.clientWidth * dpr);
      const height = Math.round(canvas.clientHeight * dpr);
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
        gl.viewport(0, 0, width, height);
      }
      const previousX = mouse.x;
      const previousY = mouse.y;
      mouse.x += (mouse.tx - mouse.x) * 0.14;
      mouse.y += (mouse.ty - mouse.y) * 0.14;
      mouse.vx += ((mouse.x - previousX) * 40 - mouse.vx) * 0.25;
      mouse.vy += ((mouse.y - previousY) * 40 - mouse.vy) * 0.25;
      gl.uniform1i(U.T, 0);
      gl.uniform2f(U.R, width, height);
      gl.uniform2f(U.I, imageWidth, imageHeight);
      gl.uniform2f(U.M, mouse.x, mouse.y);
      gl.uniform2f(U.MV, clamp(mouse.vx), clamp(mouse.vy));
      gl.uniform1f(U.t, (performance.now() - start) / 1000);
      gl.uniform1f(U.S, reduce ? 0 : motionState.scrollVelocity);
      gl.uniform1f(U.Rv, motionState.reveal);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    };
    const loop = () => {
      frame = requestAnimationFrame(loop);
      if (visible) draw();
    };

    const image = new Image();
    image.decoding = "async";
    image.onload = () => {
      imageWidth = image.naturalWidth;
      imageHeight = image.naturalHeight;
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, image);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      ready = true;
      draw();
      canvas.dataset.ready = "1";
    };
    image.src = src;

    const host = canvas.parentElement;
    const onMove = (event: PointerEvent) => {
      if (!host) return;
      const rect = host.getBoundingClientRect();
      mouse.tx = (event.clientX - rect.left) / rect.width;
      mouse.ty = 1 - (event.clientY - rect.top) / rect.height;
    };
    if (!reduce && window.matchMedia("(pointer: fine)").matches) host?.addEventListener("pointermove", onMove);
    const observer = new IntersectionObserver(([entry]) => { visible = entry?.isIntersecting ?? true; });
    observer.observe(canvas);
    if (!reduce) frame = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      host?.removeEventListener("pointermove", onMove);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    };
  }, [src]);

  return <canvas ref={ref} aria-hidden="true" />;
}
