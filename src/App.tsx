import { useState, useCallback, useMemo, useEffect, useRef, Suspense } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls, PerspectiveCamera, OrthographicCamera, Environment, Grid, Center, ContactShadows, Edges } from '@react-three/drei';
import { motion as motion2d, AnimatePresence } from 'motion/react';
import { Box, ChevronRight, RotateCcw, Eye, Layout, CheckCircle2, Info, ArrowRight, MousePointer2 } from 'lucide-react';
import confetti from 'canvas-confetti';
import * as THREE from 'three';
import { Text } from '@react-three/drei';

// --- Types ---

function trim1D(arr: number[]) {
  let start = 0;
  while (start < arr.length && arr[start] === 0) start++;
  let end = arr.length - 1;
  while (end >= 0 && arr[end] === 0) end--;
  if (start > end) return [];
  return arr.slice(start, end + 1);
}

function trim2D(grid: number[][]) {
  if (grid.length === 0) return [];
  let minR = grid.length, maxR = -1;
  let minC = grid[0].length, maxC = -1;

  for (let r = 0; r < grid.length; r++) {
    for (let c = 0; c < grid[r].length; c++) {
      if (grid[r][c] !== 0) {
        if (r < minR) minR = r;
        if (r > maxR) maxR = r;
        if (c < minC) minC = c;
        if (c > maxC) maxC = c;
      }
    }
  }

  if (maxR === -1) return [];

  const res = [];
  for (let r = minR; r <= maxR; r++) {
    res.push(grid[r].slice(minC, maxC + 1));
  }
  return res;
}

type GridPos = { id: string; x: number; y: number; z: number };

type Config = {
  id: string;
  heights: number[][]; // [y][x]
  front: number[];
  right: number[];
  top: number[][];
};

/**
 * Generate all possible 2x2 grid configurations where total cubes sum to exactly 4.
 * Coordinates used: x (0-1), y (0-1) is depth, z (0-N) is height.
 */
function generateConfigs(): Config[] {
  const configs: Config[] = [];
  // h[y][x]
  for (let h00 = 0; h00 <= 4; h00++) {
    for (let h10 = 0; h10 <= 4; h10++) {
      for (let h01 = 0; h01 <= 4; h01++) {
        for (let h11 = 0; h11 <= 4; h11++) {
          if (h00 + h10 + h01 + h11 === 4) {
            const h = [
              [h00, h10], // row y=0 (back row from observer's view at +Y)
              [h01, h11], // row y=1 (front row from observer's view at +Y)
            ];
            
            // Front View: Observer is at +3D Z looking toward -3D Z.
            // Left column seen is x=0, Right column is x=1.
            const front = trim1D([
              Math.max(h[0][0], h[1][0]), // Left col (x=0)
              Math.max(h[0][1], h[1][1])  // Right col (x=1)
            ]);
            
            // Right View: Observer is at +X looking toward -X.
            // Looking from +X with Y-axis pointing into screen:
            // World Y=0 maps to Viewport Left, World Y=1 maps to Viewport Right.
            const right = trim1D([
              Math.max(h[0][0], h[0][1]), // Observer's Left (y=0)
              Math.max(h[1][0], h[1][1])  // Observer's Right (y=1)
            ]);
            
            // Top View: [y][x] occupation map.
            const rawTop = [
              [h[1][0] > 0 ? 1 : 0, h[1][1] > 0 ? 1 : 0], // Row y=1 (Top)
              [h[0][0] > 0 ? 1 : 0, h[0][1] > 0 ? 1 : 0], // Row y=0 (Bottom)
            ];
            const top = trim2D(rawTop);
            
            configs.push({
              id: `${h00}-${h10}-${h01}-${h11}`,
              heights: h,
              front,
              right,
              top
            });
          }
        }
      }
    }
  }
  return configs;
}

const ALL_CONFIGS = generateConfigs();

const STAGES = [
  {
    id: 'intro',
    title: '准备开始',
    description: '通过选择特定视角的目标形状，挑战你的空间感。',
  },
  {
    id: 'front',
    title: '第一阶段：正视图',
    description: '摆放4个正方体，使其侧影符合当前选定的“正视图”。',
    viewType: 'front',
  },
  {
    id: 'right',
    title: '第二阶段：右视图',
    description: '在固定正视图的同时，调整位置使其“右视图”也符合你的选择。',
    viewType: 'right',
  },
  {
    id: 'top',
    title: '最终挑战：俯视图',
    description: '最后一步，让俯视图也完美匹配。此时三维结构将完全确定。',
    viewType: 'top',
  },
];

// --- Sub-components ---

function Cube({ position, color = "#3B82F6" }: { position: [number, number, number]; color?: string }) {
  const groupRef = useRef<THREE.Group>(null);
  const visualRef = useRef<THREE.Group>(null);
  const targetPos = useMemo(() => new THREE.Vector3(...position), [position]);
  const currentPos = useRef(new THREE.Vector3(...position));
  const startTime = useRef(Date.now());
  const [isNew, setIsNew] = useState(true);

  const moveData = useRef({
    isMoving: false,
    start: new THREE.Vector3(...position),
    totalDist: 0
  });

  useEffect(() => {
    if (currentPos.current.distanceTo(targetPos) > 0.05) {
      moveData.current.isMoving = true;
      moveData.current.start.copy(currentPos.current);
      moveData.current.totalDist = currentPos.current.distanceTo(targetPos);
      setIsNew(false);
    }
  }, [targetPos]);

  useFrame(() => {
    if (groupRef.current && visualRef.current) {
      // 1. Lerp logical position
      currentPos.current.lerp(targetPos, 0.18);
      groupRef.current.position.copy(currentPos.current);

      // 2. Arc/Jump Offset (applied to visual nested group)
      if (moveData.current.isMoving) {
        const distRemaining = currentPos.current.distanceTo(targetPos);
        const progress = 1 - Math.min(distRemaining / moveData.current.totalDist, 1);
        
        if (distRemaining > 0.02) {
          const jumpHeight = Math.min(moveData.current.totalDist * 0.5, 1.0);
          const jump = Math.sin(progress * Math.PI) * jumpHeight;
          visualRef.current.position.y = jump;
          visualRef.current.rotation.x = jump * 0.1;
        } else {
          moveData.current.isMoving = false;
          visualRef.current.position.y = 0;
          visualRef.current.rotation.x = 0;
        }
      }

      // 3. Juiciness
      if (isNew) {
        const elapsed = (Date.now() - startTime.current) / 1000;
        const bounce = 1 + Math.sin(elapsed * 15) * Math.exp(-elapsed * 5) * 0.4;
        groupRef.current.scale.set(bounce, bounce, bounce);
        if (elapsed > 1.2) {
          setIsNew(false);
          groupRef.current.scale.set(1, 1, 1);
        }
      } else if (!moveData.current.isMoving) {
        groupRef.current.scale.lerp(new THREE.Vector3(1, 1, 1), 0.1);
      }
    }
  });

  return (
    <group ref={groupRef}>
      <group ref={visualRef}>
        <mesh castShadow receiveShadow>
          <boxGeometry args={[0.95, 0.95, 0.95]} />
          <meshStandardMaterial color={color} roughness={0.3} metalness={0.2} />
        </mesh>
        <mesh>
          <boxGeometry args={[0.96, 0.96, 0.96]} />
          <meshStandardMaterial color="white" wireframe transparent opacity={0.15} />
        </mesh>
      </group>
    </group>
  );
}

function Scene({ cubes, onGridClick, selectedCell }: { 
  cubes: GridPos[]; 
  onGridClick: (x: number, y: number) => void;
  selectedCell: { x: number, y: number } | null;
}) {
  return (
    <>
      <ambientLight intensity={1.0} />
      <pointLight position={[10, 10, 10]} intensity={1.5} castShadow />
      <directionalLight position={[-5, 8, -5]} intensity={0.5} />
      <Environment preset="city" />

      <group>
        {/* Axes Helper */}
        <group position={[2.5, -0.52, -2.5]}>
          {/* X Axis (Red) */}
          <group>
            <mesh position={[0, 0, 0]}>
              <boxGeometry args={[7, 0.04, 0.04]} />
              <meshStandardMaterial color="#ef4444" emissive="#ef4444" emissiveIntensity={0.5} />
            </mesh>
            <mesh position={[3.5, 0, 0]} rotation={[0, 0, -Math.PI / 2]}>
              <coneGeometry args={[0.08, 0.2, 8]} />
              <meshStandardMaterial color="#ef4444" />
            </mesh>
            <Text position={[3.8, 0.2, 0]} fontSize={0.3} color="#ef4444">X</Text>
          </group>

          {/* Y Axis (Green - depth pointing into screen) */}
          <group>
            <mesh position={[0, 0, 0]}>
              <boxGeometry args={[0.04, 0.04, 7]} />
              <meshStandardMaterial color="#22c55e" emissive="#22c55e" emissiveIntensity={0.5} />
            </mesh>
            <mesh position={[0, 0, -3.5]} rotation={[-Math.PI / 2, 0, 0]}>
              <coneGeometry args={[0.08, 0.2, 8]} />
              <meshStandardMaterial color="#22c55e" />
            </mesh>
            <Text position={[0, 0.2, -3.8]} fontSize={0.3} color="#22c55e" rotation={[-Math.PI / 2, 0, 0]}>Y</Text>
          </group>

          {/* Z Axis (Blue - height) */}
          <group>
            <mesh position={[0, 2, 0]}>
              <boxGeometry args={[0.04, 4, 0.04]} />
              <meshStandardMaterial color="#3b82f6" emissive="#3b82f6" emissiveIntensity={0.5} />
            </mesh>
            <mesh position={[0, 4, 0]}>
              <coneGeometry args={[0.08, 0.2, 8]} />
              <meshStandardMaterial color="#3b82f6" />
            </mesh>
            <Text position={[0.2, 4.2, 0]} fontSize={0.3} color="#3b82f6">Z</Text>
          </group>
        </group>

        {/* Interaction Grid Area */}
        <group>
          {cubes.map((cube) => {
            const isSelected = selectedCell?.x === cube.x && selectedCell?.y === cube.y && 
                              cube.z === cubes.filter(c => c.x === cube.x && c.y === cube.y).length - 1;
            
            return (
              <Cube 
                key={cube.id} 
                position={[cube.x, isSelected ? cube.z + 0.3 : cube.z, -cube.y]} 
                color={isSelected ? "#EF4444" : "#3B82F6"}
              />
            );
          })}

          {Array.from({ length: 6 }).map((_, x) =>
            Array.from({ length: 6 }).map((_, y) => {
              const isActive = selectedCell?.x === x && selectedCell?.y === y;
              return (
                <group key={`${x}-${y}`} position={[x, -0.5, -y]}>
                  {/* Invisible Hitbox */}
                  <mesh
                    onClick={(e) => {
                      e.stopPropagation();
                      onGridClick(x, y);
                    }}
                  >
                    <boxGeometry args={[1, 0.2, 1]} />
                    <meshBasicMaterial transparent opacity={0} />
                  </mesh>

                  {/* Floor tile with edge to form the grid */}
                  <mesh position={[0, 0.005, 0]} rotation={[-Math.PI / 2, 0, 0]}>
                    <planeGeometry args={[0.95, 0.95]} />
                    <meshBasicMaterial 
                      color={isActive ? "#FF4444" : "#f1f5f9"} 
                      transparent 
                      opacity={isActive ? 0.3 : 0} 
                      depthWrite={false} 
                    />
                    <Edges color={isActive ? "#ef4444" : "#94a3b8"} scale={1} />
                  </mesh>
                </group>
              );
            })
          )}
        </group>
      </group>

      <ContactShadows opacity={0.4} scale={15} blur={2.4} far={10} color="#000000" position={[2.5, -0.6, -2.5]} />
    </>
  );
}


function ViewSilhouette({ type, values, compact = false, colorTheme = 'blue' }: { type: string; values: any; compact?: boolean; colorTheme?: 'blue' | 'red' | 'green' }) {
  const size = compact ? "w-5 h-5" : "w-6 h-6 sm:w-7 sm:h-7";
  const gap = compact ? "gap-1" : "gap-1.5";
  const cellSizeClass = `${size} rounded-sm transition-all duration-300 shadow-sm border`;
  const emptyClass = "bg-slate-100 border-slate-200";
  let filledClass = "bg-blue-600 border-blue-700 shadow-blue-100";
  if (colorTheme === 'red') filledClass = "bg-red-500 border-red-600 shadow-red-100";
  if (colorTheme === 'green') filledClass = "bg-green-500 border-green-600 shadow-green-100";

  if (!values) return <div className="p-2 h-20 flex items-center justify-center text-slate-300 italic text-[10px]">未选择</div>;

  if (type === 'front' || type === 'right') {
    const heights = values as number[];
    return (
      <div className={`flex items-end ${gap} p-2 bg-slate-50 border border-slate-200/60 rounded-xl`}>
        {heights.map((h, i) => (
          <div key={i} className={`flex flex-col-reverse ${gap}`}>
            {Array.from({ length: 4 }).map((_, j) => (
              <div
                key={j}
                className={`${cellSizeClass} ${j < h ? filledClass : emptyClass}`}
                style={{ opacity: j >= Math.max(h, 2) ? 0.3 : 1 }}
              />
            ))}
          </div>
        ))}
      </div>
    );
  }

  if (type === 'top') {
    const grid = values as number[][];
    const cols = grid.length > 0 ? grid[0].length : 1;
    return (
      <div className={`grid ${gap} p-2 bg-slate-50 border border-slate-200/60 rounded-xl`} style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
        {grid.map((row, y) =>
          row.map((cell, x) => (
            <div
              key={`${y}-${x}`}
              className={`${cellSizeClass} ${cell > 0 ? filledClass : emptyClass}`}
            />
          ))
        )}
      </div>
    );
  }

  return null;
}

// --- Camera Controller ---

// --- Camera Controller with Animation ---

function CameraManager({ view }: { view: '3d' | 'front' | 'right' | 'top' }) {
  const { camera, controls } = useThree();
  const [transitionQueue, setTransitionQueue] = useState<('3d' | 'front' | 'right' | 'top')[]>([]);
  const lastViewProp = useRef(view);
  
  const views = useMemo(() => ({
    '3d': { pos: new THREE.Vector3(12, 12, 12), target: new THREE.Vector3(2.5, 0.5, -2.5) },
    'front': { pos: new THREE.Vector3(2.5, 2.5, 12), target: new THREE.Vector3(2.5, 2.5, -2.5) },
    'right': { pos: new THREE.Vector3(12, 2.5, -2.5), target: new THREE.Vector3(2.5, 2.5, -2.5) },
    'top': { pos: new THREE.Vector3(2.5, 12, -2.5), target: new THREE.Vector3(2.5, 0, -2.5) },
  }), []);

  useEffect(() => {
    if (view !== lastViewProp.current) {
      if (lastViewProp.current === 'right' && view === 'top') {
        setTransitionQueue(['front', 'top']);
      } else if (lastViewProp.current === 'top' && view === 'right') {
        setTransitionQueue(['front', 'right']);
      } else {
        setTransitionQueue([view]);
      }
      lastViewProp.current = view;
    }
  }, [view]);

  useFrame((state) => {
    if (transitionQueue.length === 0 || !controls) return;

    const currentTargetView = transitionQueue[0];
    const orbit = controls as any;
    const targetConfig = views[currentTargetView];
    
    // Smooth camera and target lerp
    state.camera.position.lerp(targetConfig.pos, 0.08);
    orbit.target.lerp(targetConfig.target, 0.08);
    orbit.update();

    const distPos = state.camera.position.distanceTo(targetConfig.pos);
    const distTarget = orbit.target.distanceTo(targetConfig.target);

    // Use a slightly larger threshold so intermediate steps feel fluid
    // but ensure the final step snaps correctly
    const threshold = transitionQueue.length > 1 ? 0.3 : 0.01;

    if (distPos < threshold && distTarget < threshold) {
      if (transitionQueue.length === 1) {
        state.camera.position.copy(targetConfig.pos);
        orbit.target.copy(targetConfig.target);
      }
      setTransitionQueue(prev => prev.slice(1));
    }
  });

  return (
    <>
      <OrbitControls 
        makeDefault
        onStart={() => setTransitionQueue([])}
        enablePan={false}
        enableRotate={view === '3d'}
        minDistance={3}
        maxDistance={25}
      />
    </>
  );
}

// --- Main App Component ---

export default function App() {
  const [cubes, setCubes] = useState<GridPos[]>([]);
  const [stageIndex, setStageIndex] = useState(0); 
  const [mode, setMode] = useState<'select' | 'play'>('select');
  const [cameraView, setCameraView] = useState<'3d' | 'front' | 'right' | 'top'>('3d');
  
  const [selectedFront, setSelectedFront] = useState<number[] | null>(null);
  const [selectedRight, setSelectedRight] = useState<number[] | null>(null);
  const [selectedTop, setSelectedTop] = useState<number[][] | null>(null);
  const [selectedCell, setSelectedCell] = useState<{ x: number, y: number } | null>(null);
  const [feedback, setFeedback] = useState<'success' | 'error' | null>(null);

  const frontOptions = useMemo(() => {
    const unique = new Map<string, number[]>();
    ALL_CONFIGS.forEach(c => unique.set(JSON.stringify(c.front), c.front));
    return Array.from(unique.values()).sort((a, b) => (a[0] + a[1]) - (b[0] + b[1]));
  }, []);

  const rightOptions = useMemo(() => {
    if (!selectedFront) return [];
    const unique = new Map<string, number[]>();
    ALL_CONFIGS.filter(c => JSON.stringify(c.front) === JSON.stringify(selectedFront))
      .forEach(c => unique.set(JSON.stringify(c.right), c.right));
    return Array.from(unique.values()).sort((a, b) => (a[0] + a[1]) - (b[0] + b[1]));
  }, [selectedFront]);

  const topOptions = useMemo(() => {
    if (!selectedFront || !selectedRight) return [];
    const unique = new Map<string, number[][]>();
    ALL_CONFIGS.filter(c => 
      JSON.stringify(c.front) === JSON.stringify(selectedFront) &&
      JSON.stringify(c.right) === JSON.stringify(selectedRight)
    ).forEach(c => unique.set(JSON.stringify(c.top), c.top));
    return Array.from(unique.values());
  }, [selectedFront, selectedRight]);

  const currentFront = useMemo(() => {
    const v = Array(6).fill(0);
    cubes.forEach(c => { v[c.x] = Math.max(v[c.x], c.z + 1); });
    return trim1D(v);
  }, [cubes]);

  const currentRight = useMemo(() => {
    const v = Array(6).fill(0);
    cubes.forEach(c => {
      const col = c.y; // Logic Y=0 is Left, Y=1 is Right
      v[col] = Math.max(v[col], c.z + 1);
    });
    return trim1D(v);
  }, [cubes]);

  const currentTop = useMemo(() => {
    const grid = Array.from({ length: 6 }, () => Array(6).fill(0));
    cubes.forEach(c => { 
      const row = 5 - c.y; // Logic Y=5 is top row (index 0)
      grid[row][c.x] = 1; 
    });
    return trim2D(grid);
  }, [cubes]);

  // Interaction Logic: Sequential placing, then Pick and Place Move
  const handleGridClick = useCallback((x: number, y: number) => {
    if (mode === 'select') return;
    
    setCubes(prev => {
      const atPos = prev.filter(c => c.x === x && c.y === y);

      // --- PHASE 1: Placement (under 4 cubes) ---
      if (prev.length < 4) {
        if (atPos.length >= 4) return prev;
        return [...prev, { id: `cube-${Math.random().toString(36).substr(2, 9)}`, x, y, z: atPos.length }];
      }

      // --- PHASE 2: Moving (exactly 4 cubes) ---
      // 1. If we haven't selected a source yet
      if (!selectedCell) {
        if (atPos.length > 0) {
          setSelectedCell({ x, y });
        }
        return prev;
      }

      // 2. If clicking the same spot as source, deselect
      if (selectedCell.x === x && selectedCell.y === y) {
        setSelectedCell(null);
        return prev;
      }

      // 3. Move top cube from source to target
      const sourceCubes = prev.filter(c => c.x === selectedCell.x && c.y === selectedCell.y);
      const otherCubes = prev.filter(c => c.x !== selectedCell.x || c.y !== selectedCell.y);
      
      const targetCubes = prev.filter(c => c.x === x && c.y === y);
      if (targetCubes.length >= 4) {
        setSelectedCell(null);
        return prev;
      }

      const topCube = sourceCubes[sourceCubes.length - 1];
      const remainingSource = sourceCubes.slice(0, -1);
      
      const newCubes = [
        ...otherCubes.filter(c => c.x !== x || c.y !== y),
        ...targetCubes,
        ...remainingSource,
        { ...topCube, x, y, z: targetCubes.length }
      ];

      setSelectedCell(null);
      return newCubes;
    });
  }, [mode, selectedCell]);

  const checkSuccess = () => {
    setFeedback(null);
    const isFrontOk = JSON.stringify(currentFront) === JSON.stringify(selectedFront);
    const isRightOk = JSON.stringify(currentRight) === JSON.stringify(selectedRight);
    const isTopOk = JSON.stringify(currentTop) === JSON.stringify(selectedTop);

    let success = false;
    if (stageIndex === 1) success = isFrontOk;
    else if (stageIndex === 2) success = isFrontOk && isRightOk;
    else if (stageIndex === 3) success = isFrontOk && isRightOk && isTopOk;

    if (success) {
      setFeedback('success');
      setTimeout(() => {
        setFeedback(null);
        if (stageIndex < 3) {
          setMode('select');
          setStageIndex(s => s + 1);
        } else {
          confetti({ particleCount: 150, spread: 70, origin: { y: 0.6 } });
        }
      }, 1500);
    } else {
      setFeedback('error');
      setTimeout(() => setFeedback(null), 2000);
    }
  };

  const reset = () => {
    setCubes([]);
    setStageIndex(0);
    setMode('select');
    setSelectedFront(null);
    setSelectedRight(null);
    setSelectedTop(null);
    setCameraView('3d');
  };

  const targetViewData = useMemo(() => {
    if (stageIndex === 1) return selectedFront;
    if (stageIndex === 2) return selectedRight;
    if (stageIndex === 3) return selectedTop;
    return null;
  }, [stageIndex, selectedFront, selectedRight, selectedTop]);

  const currentViewData = useMemo(() => {
    if (stageIndex === 1) return currentFront;
    if (stageIndex === 2) return currentRight;
    if (stageIndex === 3) return currentTop;
    return null;
  }, [stageIndex, currentFront, currentRight, currentTop]);

  const currentViewName = stageIndex === 3 ? 'top' : stageIndex === 2 ? 'right' : 'front';

  return (
    <div className="flex flex-col h-screen w-full bg-slate-50 font-sans overflow-hidden select-none">
      <header className="bg-white border-b border-slate-200 px-8 py-4 flex justify-between items-center z-30 shadow-sm">
        <div className="flex items-center gap-4">
          <div className="bg-blue-600 text-white p-2.5 rounded-2xl shadow-lg shadow-blue-100">
            <Box size={24} />
          </div>
          <div>
            <h1 className="text-xl font-black text-slate-800 tracking-tight">立体思维实验室</h1>
            <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">三视图推导 · 动态动画版</p>
          </div>
        </div>
        
        <div className="flex gap-2.5">
          {[1, 2, 3].map((i) => (
            <div 
              key={i} 
              className={`h-2.5 rounded-full transition-all duration-500 ${
                i === stageIndex ? 'bg-blue-600 w-10 shadow-sm shadow-blue-200' : 'bg-slate-200 w-2.5'
              }`} 
            />
          ))}
        </div>
      </header>

      <main className="flex-1 grid grid-cols-12 gap-6 p-6 min-h-0">
        <section className="col-span-12 lg:col-span-8 bg-white rounded-[2.5rem] shadow-sm border border-slate-200 relative overflow-hidden">
          <div className="absolute top-6 left-6 z-20 flex flex-col gap-4">
             <div className={`flex items-center gap-2 px-4 py-2 border rounded-full font-bold text-xs shadow-sm transition-all ${
                mode === 'play' ? 'bg-green-50 border-green-200 text-green-700' : 'bg-indigo-50 border-indigo-200 text-indigo-700'
              }`}>
                <div className={`w-2 h-2 rounded-full animate-pulse ${mode === 'play' ? 'bg-green-500' : 'bg-indigo-500'}`} />
                {mode === 'play' ? '操作中：点击网格 (红色虚线为目标)' : '请选择目标视图'}
              </div>
          </div>

          <div className="absolute top-6 right-6 flex bg-white/80 backdrop-blur-md p-1 rounded-2xl border border-slate-200 z-50 shadow-lg">
            {[
              { id: '3d', label: '3D', icon: <Layout size={14} /> },
              { id: 'front', label: '正视', icon: <Eye size={14} /> },
              { id: 'right', label: '右视', icon: <Eye size={14} /> },
              { id: 'top', label: '俯视', icon: <Eye size={14} /> },
            ].map((v) => (
              <button
                key={v.id}
                onClick={() => setCameraView(v.id as any)}
                className={`flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-black transition-all ${
                  cameraView === v.id ? 'bg-blue-600 text-white shadow-md' : 'text-slate-500 hover:text-slate-800'
                }`}
              >
                {v.icon}
                {v.label}
              </button>
            ))}
          </div>

          <div className="w-full h-full">
            <Canvas orthographic shadows gl={{ antialias: true }} camera={{ position: [12, 12, 12], zoom: 45, near: -100, far: 500 }}>
              <Suspense fallback={null}>
                <CameraManager view={cameraView} />
                <Scene 
                  cubes={cubes} 
                  onGridClick={handleGridClick} 
                  selectedCell={selectedCell}
                />
              </Suspense>
            </Canvas>
          </div>

          <div className="absolute bottom-6 right-6 z-20">
            <button onClick={reset} className="bg-white text-slate-600 border border-slate-200 px-6 py-3.5 rounded-2xl font-black text-sm hover:bg-slate-50 transition-all shadow-md active:scale-95 flex items-center gap-2">
              <RotateCcw size={18} />
              重置
            </button>
          </div>
        </section>

        <aside className="col-span-12 lg:col-span-4 flex flex-col gap-6 min-h-0">
          {mode === 'select' ? (
            <div className="flex-1 flex flex-col gap-6 animate-in fade-in slide-in-from-right-8 duration-500 min-h-0">
               <div className="bg-indigo-600 text-white rounded-[2rem] p-8 shadow-xl shadow-indigo-100 flex flex-col gap-2 shrink-0">
                <h2 className="text-2xl font-black">{stageIndex === 0 ? "欢迎" : `选择目标`}</h2>
                <p className="text-indigo-100 text-sm font-medium leading-relaxed">
                   从下列列表中选择一个学生需要达成的目标{currentViewName === 'right' ? '右视图' : currentViewName === 'top' ? '俯视图' : '正视图'}。
                </p>
              </div>

              <div className="flex-1 overflow-y-auto px-1 min-h-0 custom-scrollbar">
                 <div className="flex flex-col gap-3 pb-4">
                  {(stageIndex <= 1 ? frontOptions : stageIndex === 2 ? rightOptions : topOptions).map((opt, i) => (
                    <button
                      key={i}
                      onClick={() => {
                        if (stageIndex <= 1) setSelectedFront(opt as number[]);
                        else if (stageIndex === 2) setSelectedRight(opt as number[]);
                        else setSelectedTop(opt as number[][]);
                      }}
                      className={`p-4 rounded-3xl border-2 transition-all flex items-center justify-between active:scale-[0.98] group ${
                        JSON.stringify(opt) === JSON.stringify(stageIndex <= 1 ? selectedFront : stageIndex === 2 ? selectedRight : selectedTop)
                          ? 'border-blue-600 bg-blue-50/50'
                          : 'border-slate-100 hover:border-slate-300 bg-white shadow-sm'
                      }`}
                    >
                      <div className="flex flex-col items-start gap-1">
                        <span className="text-[10px] font-black text-slate-400 group-hover:text-slate-600 uppercase">选项 {i + 1}</span>
                        <ViewSilhouette compact type={stageIndex === 3 ? 'top' : stageIndex === 2 ? 'right' : 'front'} values={opt} />
                      </div>
                      <div className={`w-8 h-8 rounded-full flex items-center justify-center transition-colors ${
                         JSON.stringify(opt) === JSON.stringify(stageIndex <= 1 ? selectedFront : stageIndex === 2 ? selectedRight : selectedTop)
                         ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-300'
                      }`}>
                        <ChevronRight size={16} />
                      </div>
                    </button>
                  ))}
                </div>
              </div>

              <div className="shrink-0 pt-2">
                <button
                  disabled={!(stageIndex <= 1 ? selectedFront : stageIndex === 2 ? selectedRight : selectedTop)}
                  onClick={() => {
                    setMode('play');
                    if (stageIndex === 0) setStageIndex(1);
                    setCameraView(stageIndex === 3 ? 'top' : stageIndex === 2 ? 'right' : 'front');
                  }}
                  className="w-full py-5 bg-slate-900 text-white rounded-3xl font-black text-lg hover:bg-black transition-all transform disabled:opacity-30 flex items-center justify-center gap-3 shadow-xl"
                >
                  确认选定并开始训练
                  <ArrowRight size={20} />
                </button>
              </div>
            </div>
          ) : (
            <div className="flex-1 flex flex-col gap-4 animate-in fade-in slide-in-from-left-8 duration-500 min-h-0">
               <div className="bg-blue-50 border border-blue-200 rounded-3xl p-5 shadow-sm shrink-0">
                <div className="flex items-center gap-3 mb-1.5">
                  <span className="text-[10px] font-black bg-blue-600 text-white px-2.5 py-1 rounded-full uppercase tracking-tighter">第 {stageIndex} 步</span>
                  <h2 className="font-black text-blue-900 text-sm sm:text-base">{STAGES[stageIndex].title}</h2>
                </div>
                <p className="text-[11px] text-blue-700/80 leading-relaxed font-semibold">
                   {STAGES[stageIndex].description}
                </p>
              </div>

              <div className="flex-1 overflow-y-auto custom-scrollbar p-1 min-h-0 space-y-4">
                <div className="bg-white rounded-[1.5rem] border border-slate-200 p-5 flex flex-col gap-6 shadow-sm">
                  <div className="space-y-3">
                    <div className="flex justify-between items-center text-lg font-black text-slate-400 uppercase tracking-widest">
                      <span>当前目标：{currentViewName === 'top' ? '俯视图' : currentViewName === 'right' ? '右视图' : '正视图'}</span>
                    </div>
                    
                    <div className="grid grid-cols-2 gap-4">
                      <div className="flex flex-col items-center gap-2">
                        <span className="text-lg font-black text-slate-400 uppercase">目标形状</span>
                        <ViewSilhouette type={currentViewName} values={targetViewData} compact={true} colorTheme="red" />
                      </div>
                      <div className="flex flex-col items-center gap-2">
                        <span className="text-lg font-black text-blue-400 uppercase">当前现状</span>
                        <ViewSilhouette type={currentViewName} values={currentViewData} compact={true} />
                      </div>
                    </div>
                  </div>

                  <div className="h-px bg-slate-100" />

                  <div className="space-y-3">
                    <div className="flex justify-between items-center text-lg font-black text-slate-400 uppercase tracking-widest">
                      <span>已锁定视图</span>
                    </div>
                    <div className="flex gap-3">
                      {selectedFront && stageIndex >= 2 && (
                        <div className="flex-1 p-2 bg-slate-50/50 rounded-xl border border-slate-100 flex flex-col items-center gap-1.5 overflow-hidden">
                           <span className={`text-lg font-bold uppercase ${JSON.stringify(currentFront) === JSON.stringify(selectedFront) ? 'text-slate-400' : 'text-red-400'}`}>正视图</span>
                           <div className="scale-75 origin-top h-auto py-1"><ViewSilhouette compact type="front" values={selectedFront} colorTheme={JSON.stringify(currentFront) === JSON.stringify(selectedFront) ? 'green' : 'red'} /></div>
                        </div>
                      )}
                      {selectedRight && stageIndex >= 3 && (
                        <div className="flex-1 p-2 bg-slate-50/50 rounded-xl border border-slate-100 flex flex-col items-center gap-1.5 overflow-hidden">
                          <span className={`text-lg font-bold uppercase ${JSON.stringify(currentRight) === JSON.stringify(selectedRight) ? 'text-slate-400' : 'text-red-400'}`}>右视图</span>
                          <div className="scale-75 origin-top h-auto py-1"><ViewSilhouette compact type="right" values={selectedRight} colorTheme={JSON.stringify(currentRight) === JSON.stringify(selectedRight) ? 'green' : 'red'} /></div>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>

              <div className="shrink-0 space-y-3">
                <button
                  disabled={cubes.length !== 4}
                  onClick={checkSuccess}
                  className={`w-full py-4 text-white rounded-3xl font-black text-lg shadow-xl active:scale-[0.98] transition-all disabled:opacity-30 flex items-center justify-center gap-3 ${
                    feedback === 'success' ? 'bg-green-500' : feedback === 'error' ? 'bg-red-500' : 'bg-blue-600 hover:bg-blue-700 shadow-blue-100'
                  }`}
                >
                  {feedback === 'success' ? '校验通过！' : feedback === 'error' ? '不匹配，请重试' : '请求校验'}
                  <CheckCircle2 size={20} />
                </button>
                {feedback === 'success' ? (
                  <button onClick={reset} className="w-full text-sm font-black text-blue-600 hover:text-blue-800 uppercase transition-colors text-center pb-1">
                    开启新练习 →
                  </button>
                ) : (
                  <button onClick={() => setMode('select')} className="w-full text-[10px] font-black text-slate-400 hover:text-slate-600 uppercase transition-colors text-center pb-1">
                    ← 重新选择
                  </button>
                )}
              </div>
            </div>
          )}
        </aside>
      </main>

      <footer className="px-8 py-5 bg-white border-t border-slate-200 flex justify-between items-center text-slate-400 z-30">
        <div className="flex items-center gap-3 text-xs font-bold">
           <Info size={16} className="text-blue-500" />
           <span>比对左侧目标形状，调整 3D 空间中的方块位置。</span>
        </div>
        <div className="flex items-center gap-10 text-xs font-black uppercase tracking-widest">
          <div className="flex items-center gap-3">
             <span className={`inline-flex px-3 py-1 rounded-lg ${cubes.length === 4 ? 'bg-green-100 text-green-600' : 'bg-blue-50 text-blue-600'}`}>
              已用方块: {cubes.length} / 4
            </span>
          </div>
        </div>
      </footer>

      <AnimatePresence>
      </AnimatePresence>
    </div>
  );
}
