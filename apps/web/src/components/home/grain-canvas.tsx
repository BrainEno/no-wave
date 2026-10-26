"use client";

import { useEffect, useRef } from "react";
import styles from "../home-page.module.css";

/**
 * Half-resolution film grain layer, redrawn several times per second.
 * Under prefers-reduced-motion a single static frame is painted.
 */
export function GrainCanvas({ reduced }: { reduced: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    let frame: ImageData | null = null;

    const paint = () => {
      if (!frame) return;
      const data = frame.data;
      for (let i = 0; i < data.length; i += 4) {
        const value = Math.random() * 255;
        data[i] = value;
        data[i + 1] = value;
        data[i + 2] = value;
        data[i + 3] = 255;
      }
      context.putImageData(frame, 0, 0);
    };

    const resize = () => {
      canvas.width = Math.ceil(window.innerWidth / 2);
      canvas.height = Math.ceil(window.innerHeight / 2);
      frame = context.createImageData(canvas.width, canvas.height);
      paint();
    };

    resize();
    window.addEventListener("resize", resize);
    const timer = reduced ? null : window.setInterval(paint, 125);

    return () => {
      window.removeEventListener("resize", resize);
      if (timer !== null) window.clearInterval(timer);
    };
  }, [reduced]);

  return <canvas ref={canvasRef} className={styles.grain} aria-hidden="true" />;
}
