"use client";

import { useMemo, useRef, useEffect } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";
import type { Design, AnalysisResult, ResponseAt } from "@/lib/types/contract";
import { jet } from "./colormap";
import ComponentModel from "./ComponentModel";
import MountSpring from "./MountSpring";
import { animClock } from "./animClock";

interface Props {
  design: Design;
  analysis: AnalysisResult | null;
  responseAt: ResponseAt | null;
  rpm: number;
  exaggeration: number;
  showMesh: boolean;
  showGhost: boolean;
  selectedId: string | null;
  selectedMode?: number | null;
  overrideMaxAmp?: number;
  onSelectMember?: (id: string) => void;
  onSelectComponent?: (id: string) => void;
  renderComponents?: boolean;
}

// Reusable scratch objects to eliminate per-frame allocations
const _tempVecA = new THREE.Vector3();
const _tempVecB = new THREE.Vector3();
const _tempMid = new THREE.Vector3();
const _tempDir = new THREE.Vector3();
const _tempQuat = new THREE.Quaternion();
const _tempScale = new THREE.Vector3();
const _tempMat4 = new THREE.Matrix4();
const _tempColor = new THREE.Color();
const _yAxis = new THREE.Vector3(0, 1, 0);

const boxGeom = new THREE.BoxGeometry(1, 1, 1);
const ghostGeom = new THREE.BoxGeometry(1, 1, 1);
const ghostMaterial = new THREE.MeshBasicMaterial({
  color: "#64748b",
  wireframe: true,
  transparent: true,
  opacity: 0.25,
});

/** Fallback: generate undeformed mesh nodes directly from design geometry when analysis is null */
function computeDesignMeshNodes(design: Design): AnalysisResult["mesh_nodes"] {
  const nodeMap = new Map(design.nodes.map((n) => [n.id, n]));
  const nodes: AnalysisResult["mesh_nodes"] = [];
  let id = 0;
  const nDiv = design.analysis?.n_elements_per_member || 6;
  for (const m of design.members) {
    const n1 = nodeMap.get(m.n1);
    const n2 = nodeMap.get(m.n2);
    if (!n1 || !n2) continue;
    for (let k = 0; k <= nDiv; k++) {
      const frac = k / nDiv;
      nodes.push({
        id: `mn_${id++}`,
        x: n1.x + (n2.x - n1.x) * frac,
        y: n1.y + (n2.y - n1.y) * frac,
        member: m.id,
      });
    }
  }
  return nodes;
}

/** Build element segments from consecutive mesh nodes per member */
function buildElements(
  meshNodes: AnalysisResult["mesh_nodes"]
): { a: number; b: number; member?: string }[] {
  const byMember = new Map<string, number[]>();
  meshNodes.forEach((n, i) => {
    const m = n.member ?? "_";
    if (!byMember.has(m)) byMember.set(m, []);
    byMember.get(m)!.push(i);
  });
  const elems: { a: number; b: number; member?: string }[] = [];
  for (const [member, idxs] of byMember) {
    for (let i = 0; i < idxs.length - 1; i++) {
      elems.push({
        a: idxs[i],
        b: idxs[i + 1],
        member: member === "_" ? undefined : member,
      });
    }
  }
  return elems;
}

export default function StructureView({
  design,
  analysis,
  responseAt,
  rpm,
  exaggeration,
  showMesh,
  showGhost,
  selectedId,
  selectedMode,
  overrideMaxAmp,
  onSelectMember,
  onSelectComponent,
  renderComponents = true,
}: Props) {
  const meshNodes = useMemo(() => {
    if (analysis?.mesh_nodes && analysis.mesh_nodes.length > 0) {
      return analysis.mesh_nodes;
    }
    return computeDesignMeshNodes(design);
  }, [analysis, design]);

  const elements = useMemo(() => buildElements(meshNodes), [meshNodes]);

  const instancedMeshRef = useRef<THREE.InstancedMesh>(null);
  const ghostInstancedMeshRef = useRef<THREE.InstancedMesh>(null);
  const outlineLinesRef = useRef<THREE.LineSegments>(null);

  // Component bobbing and mount spring scaling refs
  const compRefs = useRef<(THREE.Group | null)[]>([]);
  const springRefs = useRef<(THREE.Group | null)[]>([]);

  const statusMap = useMemo(() => {
    const m = new Map<string, "ok" | "warning" | "critical">();
    analysis?.components.forEach((c) => m.set(c.id, c.status));
    return m;
  }, [analysis]);

  const ampMax = useMemo(() => {
    if (overrideMaxAmp) return overrideMaxAmp;
    if (!analysis?.sweep.node_amp_mm?.length) return 1;
    let mx = 0.01;
    for (const row of analysis.sweep.node_amp_mm) {
      for (const v of row) mx = Math.max(mx, v);
    }
    return mx;
  }, [analysis, overrideMaxAmp]);

  const rpmIdx = useMemo(() => {
    if (!analysis?.sweep.rpm?.length) return 0;
    const rpms = analysis.sweep.rpm;
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < rpms.length; i++) {
      const d = Math.abs(rpms[i] - rpm);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    }
    return best;
  }, [analysis, rpm]);

  // Static/undeformed node coordinates
  const undeformedPositions = useMemo(() => {
    return meshNodes.map((n) => new THREE.Vector3(n.x, n.y, 0));
  }, [meshNodes]);

  // Static ghost & undeformed structure matrices (calculated when elements or positions change)
  useEffect(() => {
    if (!elements.length) return;

    const applyTransforms = (mesh: THREE.InstancedMesh, radius: number) => {
      for (let i = 0; i < elements.length; i++) {
        const el = elements[i];
        const posA = undeformedPositions[el.a] ?? _tempVecA.set(0, 0, 0);
        const posB = undeformedPositions[el.b] ?? _tempVecB.set(0, 0, 0);

        _tempMid.addVectors(posA, posB).multiplyScalar(0.5);
        _tempDir.subVectors(posB, posA);
        const len = _tempDir.length();
        if (len > 1e-9) {
          _tempDir.normalize();
          _tempQuat.setFromUnitVectors(_yAxis, _tempDir);
        } else {
          _tempQuat.identity();
        }
        _tempScale.set(radius, Math.max(1e-4, len), radius);
        _tempMat4.compose(_tempMid, _tempQuat, _tempScale);
        mesh.setMatrixAt(i, _tempMat4);
      }
      mesh.instanceMatrix.needsUpdate = true;
    };

    if (ghostInstancedMeshRef.current) {
      applyTransforms(ghostInstancedMeshRef.current, 0.0025);
    }
    if (instancedMeshRef.current) {
      applyTransforms(instancedMeshRef.current, 0.004);
    }
  }, [elements, undeformedPositions]);

  // Contour colors depend only on RPM and amplitude scale, NOT on time!
  // Recomputed and uploaded to GPU ONLY when rpm, analysis, or selection changes.
  useEffect(() => {
    if (!instancedMeshRef.current || !elements.length) return;
    const mesh = instancedMeshRef.current;

    for (let i = 0; i < elements.length; i++) {
      const el = elements[i];
      const isSelected = selectedId === el.member;

      if (isSelected) {
        _tempColor.set("#38bdf8");
      } else if (!showMesh || !analysis?.sweep?.node_amp_mm?.length) {
        _tempColor.set("#4f46e5");
      } else {
        const amp = analysis?.sweep.node_amp_mm?.[rpmIdx]?.[el.a] ?? 0;
        const t = Math.min(1, Math.max(0, amp / ampMax));
        const [r, g, b] = jet(t);
        _tempColor.setRGB(r, g, b);
      }
      mesh.setColorAt(i, _tempColor);
    }
    if (mesh.instanceColor) {
      mesh.instanceColor.needsUpdate = true;
    }
  }, [elements, analysis, rpmIdx, ampMax, showMesh, selectedId]);

  // Outline LineSegments geometry (built once per mesh)
  const linePositionsBuffer = useMemo(() => {
    if (!elements.length) return null;
    const buf = new Float32Array(elements.length * 2 * 3);
    for (let i = 0; i < elements.length; i++) {
      const el = elements[i];
      const posA = undeformedPositions[el.a] ?? _tempVecA.set(0, 0, 0);
      const posB = undeformedPositions[el.b] ?? _tempVecB.set(0, 0, 0);
      const offset = i * 6;
      buf[offset] = posA.x;
      buf[offset + 1] = posA.y;
      buf[offset + 2] = posA.z;
      buf[offset + 3] = posB.x;
      buf[offset + 4] = posB.y;
      buf[offset + 5] = posB.z;
    }
    return buf;
  }, [elements, undeformedPositions]);

  // Component metadata
  const componentData = useMemo(() => {
    const nodeMap = new Map(design.nodes.map((n) => [n.id, n]));
    return design.components.map((comp, compIdx) => {
      const member = design.members.find((m) => m.id === comp.member);
      if (!member) {
        return { comp, baseX: 0, baseY: 0, baseZ: 0, dir: 1 as 1 | -1, respComp: null };
      }
      const n1 = nodeMap.get(member.n1);
      const n2 = nodeMap.get(member.n2);
      if (!n1 || !n2) {
        return { comp, baseX: 0, baseY: 0, baseZ: 0, dir: 1 as 1 | -1, respComp: null };
      }
      const x = n1.x + (n2.x - n1.x) * comp.s;
      const y = n1.y + (n2.y - n1.y) * comp.s;
      const respComp = responseAt?.components?.find((c) => c.id === comp.id) ?? null;
      const dir: 1 | -1 = compIdx % 2 === 0 ? 1 : -1;

      return { comp, baseX: x, baseY: y, baseZ: 0, dir, respComp };
    });
  }, [design, responseAt]);

  // Selected mode data
  const modeShapeData = useMemo(() => {
    if (selectedMode == null || !analysis?.modes) return null;
    const mode = analysis.modes.find((m) => m.i === selectedMode);
    return mode?.shape ?? null;
  }, [analysis, selectedMode]);

  // 60 FPS IMPERATIVE ANIMATION (Zero React Re-renders)
  useFrame(() => {
    if (document.hidden) return;
    const t = animClock.time;
    const cosT = Math.cos(t);
    const sinT = Math.sin(t);

    const instancedMesh = instancedMeshRef.current;
    if (!instancedMesh || !elements.length) return;

    const gain = exaggeration * 0.001;
    const modeGain = exaggeration * 0.0008;
    const posAttr = outlineLinesRef.current?.geometry?.attributes?.position;
    const lineArray = posAttr ? (posAttr.array as Float32Array) : null;

    // 1. Update element transforms
    for (let i = 0; i < elements.length; i++) {
      const el = elements[i];
      const na = meshNodes[el.a];
      const nb = meshNodes[el.b];
      if (!na || !nb) continue;

      let uxa = 0, uya = 0, uxb = 0, uyb = 0;

      if (modeShapeData) {
        uya = (modeShapeData[el.a]?.[1] ?? 0) * cosT * modeGain;
        uyb = (modeShapeData[el.b]?.[1] ?? 0) * cosT * modeGain;
      } else if (responseAt?.nodes) {
        const ra = responseAt.nodes[el.a];
        if (ra) {
          uxa = (ra.ux[0] * cosT - ra.ux[1] * sinT) * gain;
          uya = (ra.uy[0] * cosT - ra.uy[1] * sinT) * gain;
        }
        const rb = responseAt.nodes[el.b];
        if (rb) {
          uxb = (rb.ux[0] * cosT - rb.ux[1] * sinT) * gain;
          uyb = (rb.uy[0] * cosT - rb.uy[1] * sinT) * gain;
        }
      }

      _tempVecA.set(na.x + uxa, na.y + uya, 0);
      _tempVecB.set(nb.x + uxb, nb.y + uyb, 0);

      _tempMid.addVectors(_tempVecA, _tempVecB).multiplyScalar(0.5);
      _tempDir.subVectors(_tempVecB, _tempVecA);
      const len = _tempDir.length();
      if (len > 1e-9) {
        _tempDir.normalize();
        _tempQuat.setFromUnitVectors(_yAxis, _tempDir);
      } else {
        _tempQuat.identity();
      }

      _tempScale.set(0.004, Math.max(1e-4, len), 0.004);
      _tempMat4.compose(_tempMid, _tempQuat, _tempScale);
      instancedMesh.setMatrixAt(i, _tempMat4);

      // Update outline buffer
      if (lineArray) {
        const offset = i * 6;
        lineArray[offset] = _tempVecA.x;
        lineArray[offset + 1] = _tempVecA.y;
        lineArray[offset + 2] = _tempVecA.z;
        lineArray[offset + 3] = _tempVecB.x;
        lineArray[offset + 4] = _tempVecB.y;
        lineArray[offset + 5] = _tempVecB.z;
      }
    }

    instancedMesh.instanceMatrix.needsUpdate = true;

    if (posAttr) {
      posAttr.needsUpdate = true;
    }

    // 2. Update attached components bobbing and mount spring scaling
    if (renderComponents) {
      for (let idx = 0; idx < componentData.length; idx++) {
        const cData = componentData[idx];
        const compGroup = compRefs.current[idx];
        const springGroup = springRefs.current[idx];

        let uy = 0;
        if (cData.respComp) {
          uy = (cData.respComp.uy[0] * cosT - cData.respComp.uy[1] * sinT) * gain;
        }

        if (compGroup) {
          compGroup.position.y = cData.baseY + uy;
        }
        if (springGroup) {
          const restLen = 0.012;
          const scaleY = Math.max(0.2, (restLen + uy) / restLen);
          springGroup.scale.set(1, scaleY, 1);
        }
      }
    }
  });

  return (
    <group>
      {/* Ghost (undeformed) wireframe overlay (static, 1 draw call) */}
      {showGhost && elements.length > 0 && (
        <instancedMesh
          ref={ghostInstancedMeshRef}
          args={[ghostGeom, ghostMaterial, elements.length]}
          frustumCulled={false}
        />
      )}

      {/* Deformed 3D Beam Elements (InstancedMesh: 1 single draw call for all elements) */}
      {elements.length > 0 && (
        <instancedMesh
          ref={instancedMeshRef}
          args={[boxGeom, undefined, elements.length]}
          frustumCulled={false}
          onClick={(e) => {
            if (e.instanceId != null && elements[e.instanceId]?.member) {
              e.stopPropagation();
              onSelectMember?.(elements[e.instanceId].member!);
            }
          }}
        >
          <meshStandardMaterial
            metalness={0.4}
            roughness={0.4}
            emissive={selectedId ? "#0284c7" : "#000000"}
            emissiveIntensity={selectedId ? 0.3 : 0}
          />
        </instancedMesh>
      )}

      {/* Merged LineSegments Outline (replaces 100 per-element drei <Edges/> calls) */}
      {showMesh && linePositionsBuffer && (
        <lineSegments ref={outlineLinesRef}>
          <bufferGeometry>
            <bufferAttribute
              attach="attributes-position"
              args={[linePositionsBuffer, 3]}
            />
          </bufferGeometry>
          <lineBasicMaterial color="#0f172a" transparent opacity={0.6} />
        </lineSegments>
      )}

      {/* Lumped Components & Dynamic Mount Springs */}
      {renderComponents &&
        componentData.map((cData, idx) => (
          <group
            key={cData.comp.id}
            position={[cData.baseX, 0, cData.baseZ]}
            onClick={(e) => {
              e.stopPropagation();
              onSelectComponent?.(cData.comp.id);
            }}
          >
            <group
              ref={(el) => {
                springRefs.current[idx] = el;
              }}
              position={[0, cData.baseY, 0]}
            >
              <MountSpring
                position={[0, 0, 0]}
                restLength={0.012}
                preset={cData.comp.mount?.preset}
                kv={cData.comp.mount?.kv}
              />
            </group>

            <group
              ref={(el) => {
                compRefs.current[idx] = el;
              }}
              position={[0, cData.baseY, 0]}
            >
              <ComponentModel
                kind={cData.comp.kind}
                status={statusMap.get(cData.comp.id) ?? "ok"}
                rpm={cData.comp.kind === "motor" || cData.comp.kind === "fan" ? rpm : 0}
                dir={cData.dir}
                selected={selectedId === cData.comp.id}
              />
            </group>
          </group>
        ))}
    </group>
  );
}
