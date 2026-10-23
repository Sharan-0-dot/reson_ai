"use client";

import { useMemo, useRef, memo } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import type { MountPreset } from "@/lib/types/contract";

const PRESET_COLORS: Record<string, string> = {
  rubber_soft: "#18181b",
  rubber_medium: "#27272a",
  silicone_gel: "#38bdf8",
  foam: "#a16207",
  steel_spring: "#e2e8f0",
  wire_rope: "#94a3b8",
  rigid: "#475569",
  custom: "#64748b",
};

interface Props {
  restLength?: number;
  relDisp?: number;
  preset?: MountPreset;
  kv?: number;
  position: [number, number, number];
}

function MountSpringInternal({
  restLength = 0.012,
  relDisp = 0,
  preset = "rubber_medium",
  kv,
  position,
}: Props) {
  const meshRef = useRef<THREE.Mesh>(null);

  const geometry = useMemo(() => {
    const turns = 6;
    const points: THREE.Vector3[] = [];
    const radius = 0.0035;
    const segments = turns * 20;

    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      const angle = t * turns * Math.PI * 2;
      points.push(
        new THREE.Vector3(
          Math.cos(angle) * radius,
          t * restLength,
          Math.sin(angle) * radius
        )
      );
    }
    const curve = new THREE.CatmullRomCurve3(points);
    return new THREE.TubeGeometry(curve, 72, 0.00065, 8, false);
  }, [restLength]);

  useFrame(() => {
    if (!meshRef.current) return;
    const scale = Math.max(0.2, (restLength + relDisp) / restLength);
    meshRef.current.scale.y = scale;
  });

  // Visually adapt spring appearance based on actual stiffness if available
  const isSilicone = kv != null ? kv < 15_000 : preset === "silicone_gel";
  const isSpring = kv != null ? kv >= 80_000 : (preset === "steel_spring" || preset === "wire_rope");
  const color = isSilicone
    ? "#38bdf8"
    : isSpring
    ? "#e2e8f0"
    : PRESET_COLORS[preset] ?? PRESET_COLORS.custom;

  return (
    <group position={position}>
      {/* Lower mounting pad */}
      <mesh position={[0, 0.0008, 0]}>
        <cylinderGeometry args={[0.0045, 0.0045, 0.0016, 16]} />
        <meshStandardMaterial color="#334155" metalness={0.7} roughness={0.3} />
      </mesh>

      {/* Helical dynamic spring coil */}
      <mesh ref={meshRef} geometry={geometry}>
        <meshStandardMaterial
          color={color}
          metalness={isSpring ? 0.9 : 0.15}
          roughness={isSilicone ? 0.2 : 0.45}
          transparent={isSilicone}
          opacity={isSilicone ? 0.8 : 1.0}
        />
      </mesh>

      {/* Upper mounting collar */}
      <mesh position={[0, restLength, 0]}>
        <cylinderGeometry args={[0.0045, 0.0045, 0.0016, 16]} />
        <meshStandardMaterial color="#334155" metalness={0.7} roughness={0.3} />
      </mesh>
    </group>
  );
}

export default memo(MountSpringInternal);
