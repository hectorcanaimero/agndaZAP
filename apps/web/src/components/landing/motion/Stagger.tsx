"use client";

import { motion, useReducedMotion } from "framer-motion";
import { useEffect, useState, type PropsWithChildren } from "react";

type StaggerAs = "div" | "ul" | "ol" | "section";

interface StaggerProps extends PropsWithChildren {
  /** Delay entre cada hijo, en segundos. Default 0.08s. */
  gap?: number;
  className?: string;
  as?: StaggerAs;
}

export function Stagger({
  children,
  gap = 0.08,
  className,
  as = "div",
}: StaggerProps) {
  const reduce = useReducedMotion();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  if (!mounted || reduce) {
    const Fallback = as;
    return <Fallback className={className}>{children}</Fallback>;
  }
  const MotionComp = motion[as];
  return (
    <MotionComp
      className={className}
      initial="hidden"
      whileInView="visible"
      viewport={{ once: true, margin: "-60px" }}
      variants={{ visible: { transition: { staggerChildren: gap } } }}
    >
      {children}
    </MotionComp>
  );
}

type StaggerItemAs = "div" | "li" | "article";

export function StaggerItem({
  children,
  className,
  as = "div",
}: PropsWithChildren<{ className?: string; as?: StaggerItemAs }>) {
  const reduce = useReducedMotion();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  if (!mounted || reduce) {
    const Fallback = as;
    return <Fallback className={className}>{children}</Fallback>;
  }
  const MotionComp = motion[as];
  return (
    <MotionComp
      className={className}
      variants={{
        hidden: { opacity: 0, y: 12 },
        visible: {
          opacity: 1,
          y: 0,
          transition: { duration: 0.45, ease: [0.22, 1, 0.36, 1] },
        },
      }}
    >
      {children}
    </MotionComp>
  );
}
