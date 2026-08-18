"use client";

import { motion, useReducedMotion } from "framer-motion";
import { useEffect, useState, type PropsWithChildren } from "react";

interface FadeInProps extends PropsWithChildren {
  delay?: number;
  className?: string;
  as?: "div" | "section" | "article" | "header";
}

export function FadeIn({
  children,
  delay = 0,
  className,
  as = "div",
}: FadeInProps) {
  const reduce = useReducedMotion();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Antes de hidratar (server + primer render cliente) devolvemos el elemento
  // nativo para evitar hydration mismatch: motion.* aplica style inline en SSR
  // y framer lo remueve al hidratar. Post-mount recién montamos motion.*.
  if (!mounted || reduce) {
    const Fallback = as;
    return <Fallback className={className}>{children}</Fallback>;
  }

  const MotionComp = motion[as];

  return (
    <MotionComp
      className={className}
      initial={{ opacity: 0, y: 16 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-80px" }}
      transition={{ duration: 0.5, delay, ease: [0.22, 1, 0.36, 1] }}
    >
      {children}
    </MotionComp>
  );
}
