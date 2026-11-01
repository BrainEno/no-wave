"use client";

import { useEffect, useRef } from "react";
import { motionState } from "@/lib/motion-state.ts";

const VERTEX_SHADER =
  "attribute vec2 p;varying vec2 v;void main(){v=p*.5+.5;gl_Position=vec4(p,0.,1.);}";

const FRAGMENT_SHADER =
  "precision highp float;varying vec2 v;uniform sampler2D T;uniform vec2 R,I,M,MV;uniform float t,S,Rv;" +
  "float h(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}" +
  "float n(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(h(i),h(i+vec2(1,0)),f.x),mix(h(i+vec2(0,1)),h(i+vec2(1,1)),f.x),f.y);}" +
  "void main(){float sc=max(R.x/I.x,R.y/I.y);vec2 uv=(v-.5)*R/(I*sc)+.5;uv.y=1.-uv.y;float a=1.-Rv;" +
  "vec2 f=vec2(n(uv*3.+t*.06),n(uv*3.+9.-t*.05))-.5;vec2 d=(v-M)*vec2(R.x/R.y,1.);float m=exp(-dot(d,d)*16.);" +
  "vec2 dir=vec2(.12*a,S*.14)+MV*m*.9;vec2 o=f*(.012+.07*a)+MV*m*.25;vec3 c=vec3(0.);" +
  "for(int i=0;i<10;i++){float k=float(i)/9.-.5;c+=texture2D(T,uv+o+dir*k).rgb;}c/=10.;" +
  "float r=texture2D(T,uv+o+dir*.62).r;c.r=mix(c.r,r,.5*clamp(a+abs(S)+length(MV)*m*2.,0.,1.));" +
  "c+=(h(v*R+t)-.5)*.045;gl_FragColor=vec4(c,1.);}";

function compileShader(gl: WebGLRenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

/**
 * 首屏涂抹着色器（demo / PR29 管线）：载入后从重度涂抹浮现；鼠标划过推开颜料；
 * 滚动越快涂抹越重。任何失败（无 WebGL、着色器/链接错误、纹理异常、驱动把
 * 画面栅格化成纯色）都会移除画布，露出下方静态封面图 —— 首屏绝不允许白屏。
 */
export function HeroCanvas({ src }: { src: string }) {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    const hero = canvas?.closest<HTMLElement>("[data-hero]") ?? canvas?.parentElement ?? null;
    if (!canvas || !hero) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) motionState.reveal = 1;

    const gl = canvas.getContext("webgl", { antialias: false, alpha: false });
    if (!gl) {
      canvas.remove();
      return;
    }

    const vertex = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
    const fragment = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
    const program = gl.createProgram();
    if (!vertex || !fragment || !program) {
      canvas.remove();
      return;
    }
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      canvas.remove();
      return;
    }
    gl.useProgram(program);

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, "p");
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

    const uniform = (name: string) => gl.getUniformLocation(program, name);
    const U = {
      T: uniform("T"), R: uniform("R"), I: uniform("I"), M: uniform("M"),
      MV: uniform("MV"), t: uniform("t"), S: uniform("S"), Rv: uniform("Rv"),
    };
    if (Object.values(U).some((location) => location === null)) {
      canvas.remove();
      return;
    }

    const texture = gl.createTexture();
    // 1×1 深色种子纹理：采样永远命中有效数据，避免未初始化纹理。
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([15, 13, 12, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const mouse = { x: 0.5, y: 0.5, tx: 0.5, ty: 0.5, vx: 0, vy: 0 };
    let imageWidth = 1;
    let imageHeight = 1;
    let ready = false;
    let visible = true;
    let frame = 0;
    let drawCount = 0;
    const start = performance.now();
    const clamp = (value: number) => Math.max(-1.5, Math.min(1.5, value));

    /** 连续两帧栅格化成纯色（部分驱动遇到异常会输出白/黑平面）→ 弃用画布，露出静态封面图。 */
    const checkFrame = () => {
      const points: Array<[number, number]> = [
        [Math.floor(canvas.width * 0.2), Math.floor(canvas.height * 0.2)],
        [Math.floor(canvas.width * 0.8), Math.floor(canvas.height * 0.3)],
        [Math.floor(canvas.width * 0.5), Math.floor(canvas.height * 0.5)],
        [Math.floor(canvas.width * 0.3), Math.floor(canvas.height * 0.8)],
        [Math.floor(canvas.width * 0.7), Math.floor(canvas.height * 0.7)],
      ];
      const pixel = new Uint8Array(4);
      let min = 255;
      let max = 0;
      for (const [x, y] of points) {
        gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
        const lum = (pixel[0] + pixel[1] + pixel[2]) / 3;
        if (lum < min) min = lum;
        if (lum > max) max = lum;
      }
      if (max - min < 6) {
        ready = false;
        cancelAnimationFrame(frame);
        canvas.remove();
      }
    };

    const draw = () => {
      if (!ready) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.round(canvas.clientWidth * dpr);
      const height = Math.round(canvas.clientHeight * dpr);
      // 0 尺寸帧会把 R/(I*sc) 之类除成 NaN，NaN 片元在部分驱动上栅格化为白色。
      if (width < 2 || height < 2) return;
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
      drawCount += 1;
      if (drawCount === 2) checkFrame();
    };
    const loop = () => {
      frame = requestAnimationFrame(loop);
      if (visible) draw();
    };

    const image = new Image();
    image.decoding = "async";
    image.onload = () => {
      if (!image.naturalWidth || !image.naturalHeight) {
        canvas.remove();
        return;
      }
      imageWidth = image.naturalWidth;
      imageHeight = image.naturalHeight;
      gl.bindTexture(gl.TEXTURE_2D, texture);
      // RGBA 上传：RGB 内部格式纹理在部分驱动上被采样为纯白。
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      ready = true;
      draw();
      canvas.dataset.ready = "1";
    };
    image.onerror = () => {
      canvas.remove();
    };
    image.src = src;

    const onMove = (event: PointerEvent) => {
      const rect = hero.getBoundingClientRect();
      mouse.tx = (event.clientX - rect.left) / rect.width;
      mouse.ty = 1 - (event.clientY - rect.top) / rect.height;
    };
    if (!reduce && window.matchMedia("(pointer: fine)").matches) hero.addEventListener("pointermove", onMove);
    const observer = new IntersectionObserver(([entry]) => { visible = entry?.isIntersecting ?? true; });
    observer.observe(canvas);
    if (!reduce) frame = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      hero.removeEventListener("pointermove", onMove);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    };
  }, [src]);

  return <canvas ref={ref} aria-hidden="true" />;
}
