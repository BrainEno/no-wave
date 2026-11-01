"use client";

import { useEffect, useRef } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import styles from "../home-page.module.css";

gsap.registerPlugin(ScrollTrigger);

export type HeroMotionState = { rev: number; sv: number };

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
  return shader;
}

/**
 * Hero "smear" shader: a 10-tap directional blur driven by scroll velocity and
 * pointer momentum over the hero artwork. Falls back to the plain <img> when
 * WebGL is unavailable.
 */
export function HeroGlCanvas({
  src,
  motionRef,
}: {
  src: string;
  motionRef: React.RefObject<HeroMotionState>;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const hero = canvas?.closest<HTMLElement>("[data-hero]");
    if (!canvas || !hero) return;
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
    const positionLocation = gl.getAttribLocation(program, "p");
    gl.enableVertexAttribArray(positionLocation);
    gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

    const uniformNames = ["T", "R", "I", "M", "MV", "t", "S", "Rv"] as const;
    const uniforms: Record<(typeof uniformNames)[number], WebGLUniformLocation | null> = {
      T: null, R: null, I: null, M: null, MV: null, t: null, S: null, Rv: null,
    };
    for (const name of uniformNames) uniforms[name] = gl.getUniformLocation(program, name);
    if (Object.values(uniforms).some((location) => location === null)) {
      canvas.remove();
      return;
    }

    const texture = gl.createTexture();
    let imageWidth = 1;
    let imageHeight = 1;
    let ready = false;
    let glOn = true;
    const image = new Image();
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
      canvas.style.opacity = "1";
    };
    image.src = src;
    canvas.style.opacity = "0";

    const pointer = { x: 0.5, y: 0.5, tx: 0.5, ty: 0.5, vx: 0, vy: 0 };
    const onPointerMove = (event: PointerEvent) => {
      const rect = hero.getBoundingClientRect();
      pointer.tx = (event.clientX - rect.left) / rect.width;
      pointer.ty = 1 - (event.clientY - rect.top) / rect.height;
    };
    const finePointer = window.matchMedia("(pointer: fine)").matches;
    if (finePointer) hero.addEventListener("pointermove", onPointerMove);

    const onResize = () => {
      window.setTimeout(draw, 50);
    };
    window.addEventListener("resize", onResize);

    const start = performance.now();
    const clamp = (value: number) => Math.max(-1.5, Math.min(1.5, value));

    const draw = () => {
      if (!ready || !glOn) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.round(canvas.clientWidth * dpr);
      const height = Math.round(canvas.clientHeight * dpr);
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
        gl.viewport(0, 0, width, height);
      }
      const previousX = pointer.x;
      const previousY = pointer.y;
      pointer.x += (pointer.tx - pointer.x) * 0.14;
      pointer.y += (pointer.ty - pointer.y) * 0.14;
      pointer.vx += ((pointer.x - previousX) * 40 - pointer.vx) * 0.25;
      pointer.vy += ((pointer.y - previousY) * 40 - pointer.vy) * 0.25;
      const motion = motionRef.current;
      if (motion) motion.sv *= 0.92;

      gl.uniform1i(uniforms.T, 0);
      gl.uniform2f(uniforms.R, width, height);
      gl.uniform2f(uniforms.I, imageWidth, imageHeight);
      gl.uniform2f(uniforms.M, pointer.x, pointer.y);
      gl.uniform2f(uniforms.MV, clamp(pointer.vx), clamp(pointer.vy));
      gl.uniform1f(uniforms.t, (performance.now() - start) / 1000);
      gl.uniform1f(uniforms.S, motion ? motion.sv : 0);
      gl.uniform1f(uniforms.Rv, motion ? motion.rev : 1);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    };

    gsap.ticker.add(draw);
    const trigger = ScrollTrigger.create({
      trigger: hero,
      start: "top top",
      end: "bottom top",
      onToggle: (self) => {
        glOn = self.isActive;
      },
    });

    return () => {
      gsap.ticker.remove(draw);
      trigger.kill();
      window.removeEventListener("resize", onResize);
      if (finePointer) hero.removeEventListener("pointermove", onPointerMove);
      image.onload = null;
      gl.deleteTexture(texture);
      gl.deleteProgram(program);
      gl.deleteShader(vertex);
      gl.deleteShader(fragment);
      gl.deleteBuffer(buffer);
    };
  }, [src, motionRef]);

  return <canvas ref={canvasRef} className={styles.gl} aria-hidden="true" />;
}
