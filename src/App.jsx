import { useState, useRef, useEffect, useCallback } from "react";
import * as THREE from "three";

// ─── Constants ───
const RESOURCES = [
  { name: "topoBuilder", desc: "Custom USGS-style topographic maps", url: "https://apps.nationalmap.gov/topobuilder/", color: "#6b8f4a" },
  { name: "topoView", desc: "Historical USGS topo map archive", url: "https://ngmdb.usgs.gov/topoview/", color: "#a67c52" },
  { name: "National Map Viewer", desc: "Hi-res elevation & hydrography", url: "https://apps.nationalmap.gov/viewer/", color: "#4a7f9b" },
  { name: "OpenTopography", desc: "Point cloud & raster datasets", url: "https://opentopography.org/", color: "#d4b896" },
];

const QUICK = [
  { label: "Seattle Region", q: "Pacific Northwest Seattle to Bellingham to Olympics" },
  { label: "New York City", q: "New York City Manhattan skyline region" },
  { label: "Himalayas", q: "Mount Everest wide Himalayan region Nepal Tibet" },
  { label: "Grand Canyon", q: "Grand Canyon Colorado Plateau wide region" },
  { label: "Swiss Alps", q: "Swiss Alps wide region" },
  { label: "Hawaiian Islands", q: "Hawaii Big Island volcanoes wide region" },
  { label: "Andes", q: "Andes Mountains Patagonia wide region" },
];

// ─── Unit conversion ───
const M_TO_FT = 3.28084;
const toFt = (m) => Math.round((m || 0) * M_TO_FT).toLocaleString();

// ─── Build heightmap from regional landmark elevations ───
function buildRegionalHeightmap(size, regionData) {
  const { landmarks, bounds, region_name } = regionData;
  const data = new Float32Array(size * size);

  const latRange = bounds.north - bounds.south;
  const lngRange = bounds.east - bounds.west;
  const seed = region_name.split("").reduce((a, c) => a + c.charCodeAt(0), 0);

  // Seeded noise
  const hash = (x, y, s) => {
    const d = x * 12.9898 + y * 78.233 + s * 43758.5453;
    const sn = Math.sin(d) * 43758.5453;
    return sn - Math.floor(sn);
  };
  const smoothNoise = (x, y, freq, s) => {
    const ix = Math.floor(x * freq), iy = Math.floor(y * freq);
    const fx = x * freq - ix, fy = y * freq - iy;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    return (hash(ix, iy, s) * (1 - sx) + hash(ix + 1, iy, s) * sx) * (1 - sy) +
           (hash(ix, iy + 1, s) * (1 - sx) + hash(ix + 1, iy + 1, s) * sx) * sy;
  };

  const fbm = (x, y, s) => {
    let v = 0;
    v += smoothNoise(x, y, 3, s) * 0.4;
    v += smoothNoise(x, y, 6, s + 1) * 0.25;
    v += smoothNoise(x, y, 12, s + 2) * 0.15;
    v += smoothNoise(x, y, 24, s + 3) * 0.1;
    v += smoothNoise(x, y, 48, s + 4) * 0.06;
    v += smoothNoise(x, y, 96, s + 5) * 0.04;
    return v;
  };

  // Map landmark positions to grid space and find elevation extremes
  const mappedLandmarks = landmarks.map(lm => ({
    gx: ((lm.longitude - bounds.west) / lngRange),
    gy: 1 - ((lm.latitude - bounds.south) / latRange),
    elev: lm.elevation_m,
    radius: lm.influence_radius || 0.2,
    name: lm.name,
    type: lm.type || "peak",
  }));

  let globalMin = Infinity, globalMax = -Infinity;
  landmarks.forEach(lm => {
    if (lm.elevation_m < globalMin) globalMin = lm.elevation_m;
    if (lm.elevation_m > globalMax) globalMax = lm.elevation_m;
  });

  const baseElev = regionData.base_elevation || Math.max(0, globalMin);
  const elevRange = (globalMax - Math.min(0, globalMin)) || 1000;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const nx = x / (size - 1);
      const ny = y / (size - 1);

      // Base terrain from noise
      let elevation = baseElev + fbm(nx, ny, seed) * elevRange * 0.3;

      // Influence from landmarks — each creates a gaussian bump or depression
      for (const lm of mappedLandmarks) {
        const dx = nx - lm.gx;
        const dy = ny - lm.gy;
        const dist2 = dx * dx + dy * dy;
        const r = lm.radius;
        const influence = Math.exp(-dist2 / (2 * r * r * 0.04));

        // Add directional noise so ridges don't look like perfect cones
        const ridgeNoise = fbm(nx + lm.gx, ny + lm.gy, seed + 10) * 0.4 + 0.6;

        if (lm.type === "valley" || lm.type === "water" || lm.type === "canyon") {
          elevation = elevation * (1 - influence * 0.8 * ridgeNoise) + lm.elev * influence * 0.8 * ridgeNoise;
        } else if (lm.type === "skyline" || lm.type === "city") {
          // Cities / skylines: gentle flat area
          elevation = elevation * (1 - influence * 0.5 * ridgeNoise) + lm.elev * influence * 0.5 * ridgeNoise;
        } else {
          elevation = elevation * (1 - influence * ridgeNoise) + lm.elev * influence * ridgeNoise;
        }
      }

      // Add detail noise proportional to local elevation
      const detailScale = Math.abs(elevation - baseElev) / elevRange;
      elevation += (fbm(nx + 0.5, ny + 0.5, seed + 20) - 0.5) * elevRange * 0.08 * (0.3 + detailScale * 0.7);

      // Edge fade
      const ex = Math.min(nx, 1 - nx) * 5;
      const ey = Math.min(ny, 1 - ny) * 5;
      const edgeFade = Math.min(1, Math.min(ex, ey));
      elevation = baseElev + (elevation - baseElev) * Math.max(edgeFade, 0.05);

      data[y * size + x] = elevation;
    }
  }
  return { data, globalMin: Math.min(globalMin, baseElev), globalMax };
}

// ─── 3D Regional Terrain Renderer ───
function RegionalTerrain3D({ regionData }) {
  const containerRef = useRef(null);
  const rendererRef = useRef(null);
  const frameRef = useRef(null);
  const isDragging = useRef(false);
  const lastMouse = useRef({ x: 0, y: 0 });
  const rotation = useRef({ theta: Math.PI * 0.3, phi: Math.PI * 0.28 });
  const distance = useRef(3.5);
  const panOffset = useRef({ x: 0, y: 0 });

  useEffect(() => {
    if (!containerRef.current || !regionData) return;
    const container = containerRef.current;
    const W = container.clientWidth;
    const H = container.clientHeight;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x12140f);
    scene.fog = new THREE.FogExp2(0x12140f, 0.08);

    const camera = new THREE.PerspectiveCamera(45, W / H, 0.1, 100);
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(W, H);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.innerHTML = "";
    container.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    // Build heightmap
    const gridSize = 180;
    const { data: heightmap, globalMin, globalMax } = buildRegionalHeightmap(gridSize, regionData);
    const elevRange = globalMax - globalMin || 1;

    // Height scale factor — taller for bigger elevation ranges
    const heightScale = Math.min(1.8, Math.max(0.4, elevRange / 4000));

    // Terrain geometry
    const terrainW = 5;
    const terrainD = 5;
    const geo = new THREE.PlaneGeometry(terrainW, terrainD, gridSize - 1, gridSize - 1);
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);

    // USGS-style color ramp
    const colorAt = (t) => {
      if (t < -0.02) return [0.12, 0.28, 0.42]; // deep water
      if (t < 0.0) return [0.18, 0.38, 0.52]; // shallow water
      if (t < 0.04) return [0.22, 0.44, 0.30]; // shore
      if (t < 0.12) return [0.28, 0.52, 0.28];
      if (t < 0.22) return [0.36, 0.60, 0.30];
      if (t < 0.32) return [0.48, 0.68, 0.34];
      if (t < 0.42) return [0.58, 0.74, 0.38];
      if (t < 0.52) return [0.68, 0.78, 0.42];
      if (t < 0.62) return [0.76, 0.74, 0.48];
      if (t < 0.72) return [0.80, 0.68, 0.46];
      if (t < 0.82) return [0.76, 0.58, 0.42];
      if (t < 0.90) return [0.68, 0.50, 0.40];
      if (t < 0.96) return [0.82, 0.78, 0.74]; // rock
      return [0.92, 0.90, 0.88]; // snow
    };

    const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

    for (let i = 0; i < pos.count; i++) {
      const ix = i % gridSize;
      const iy = Math.floor(i / gridSize);
      const elevation = heightmap[iy * gridSize + ix];
      const normalized = (elevation - globalMin) / elevRange;
      const z = normalized * heightScale;
      pos.setZ(i, z);

      const col = colorAt(normalized);
      colors[i * 3] = col[0];
      colors[i * 3 + 1] = col[1];
      colors[i * 3 + 2] = col[2];
    }

    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();

    const mat = new THREE.MeshPhongMaterial({
      vertexColors: true,
      shininess: 8,
      side: THREE.DoubleSide,
      flatShading: false,
    });
    const terrain = new THREE.Mesh(geo, mat);
    terrain.rotation.x = -Math.PI / 2;
    scene.add(terrain);

    // ─── Contour Lines ───
    const numContours = 30;
    const contourGroup = new THREE.Group();

    for (let c = 1; c < numContours; c++) {
      const t = c / numContours;
      const contourElev = globalMin + t * elevRange;
      const contourZ = t * heightScale + 0.002;
      const isMajor = c % 5 === 0;

      const segments = [];
      for (let y = 0; y < gridSize - 1; y++) {
        for (let x = 0; x < gridSize - 1; x++) {
          const h00 = heightmap[y * gridSize + x];
          const h10 = heightmap[y * gridSize + x + 1];
          const h01 = heightmap[(y + 1) * gridSize + x];
          const h11 = heightmap[(y + 1) * gridSize + x + 1];

          const toWorld = (gx, gy) => new THREE.Vector3(
            (gx / (gridSize - 1)) * terrainW - terrainW / 2,
            contourZ,
            -((gy / (gridSize - 1)) * terrainD - terrainD / 2)
          );

          const edges = [
            [h00, h10, x, y, x + 1, y],
            [h10, h11, x + 1, y, x + 1, y + 1],
            [h01, h11, x, y + 1, x + 1, y + 1],
            [h00, h01, x, y, x, y + 1],
          ];

          const crossings = [];
          for (const [ha, hb, ax, ay, bx, by] of edges) {
            if ((ha <= contourElev && hb > contourElev) || (ha > contourElev && hb <= contourElev)) {
              const frac = (contourElev - ha) / (hb - ha);
              crossings.push(toWorld(ax + frac * (bx - ax), ay + frac * (by - ay)));
            }
          }
          if (crossings.length >= 2) {
            segments.push(crossings[0], crossings[1]);
          }
        }
      }

      if (segments.length > 1) {
        const lineGeo = new THREE.BufferGeometry().setFromPoints(segments);
        const lineMat = new THREE.LineBasicMaterial({
          color: isMajor ? 0x9B7928 : 0x6b5a30,
          transparent: true,
          opacity: isMajor ? 0.55 : 0.2,
        });
        contourGroup.add(new THREE.LineSegments(lineGeo, lineMat));
      }
    }
    scene.add(contourGroup);

    // ─── Landmark 3D anchors (subtle ground dots only — labels are HTML overlay) ───
    const { landmarks, bounds } = regionData;
    const latRange = bounds.north - bounds.south;
    const lngRange = bounds.east - bounds.west;

    landmarks.forEach(lm => {
      const gx = (lm.longitude - bounds.west) / lngRange;
      const gy = 1 - (lm.latitude - bounds.south) / latRange;
      const wx = gx * terrainW - terrainW / 2;
      const wz = -(gy * terrainD - terrainD / 2);
      const normalized = (lm.elevation_m - globalMin) / elevRange;
      const wy = normalized * heightScale;

      // Small glowing dot at ground level
      const dotGeo = new THREE.SphereGeometry(0.015, 6, 6);
      const isWater = lm.type === "water" || lm.type === "valley" || lm.type === "canyon";
      const dotMat = new THREE.MeshBasicMaterial({ color: isWater ? 0x5aafdd : 0xe8dcc8 });
      const dot = new THREE.Mesh(dotGeo, dotMat);
      dot.position.set(wx, wy + 0.01, wz);
      scene.add(dot);

      // ─── 3D Buildings for skyline cities ───
      if (lm.type === "skyline" || lm.buildings) {
        const buildingGroup = new THREE.Group();
        const buildingCount = 35 + Math.floor(Math.random() * 25);
        const citySpread = 0.12;

        for (let b = 0; b < buildingCount; b++) {
          const bx = wx + (Math.random() - 0.5) * citySpread;
          const bz = wz + (Math.random() - 0.5) * citySpread;

          // Vary building heights — some tall skyscrapers, many medium
          const isTall = Math.random() < 0.15;
          const isMed = Math.random() < 0.4;
          const bHeight = isTall
            ? 0.08 + Math.random() * 0.18
            : isMed
            ? 0.03 + Math.random() * 0.06
            : 0.015 + Math.random() * 0.03;

          const bWidth = isTall ? 0.006 + Math.random() * 0.008 : 0.004 + Math.random() * 0.008;
          const bDepth = isTall ? 0.006 + Math.random() * 0.008 : 0.004 + Math.random() * 0.008;

          const bGeo = new THREE.BoxGeometry(bWidth, bHeight, bDepth);

          // Glass/steel look with slight color variation
          const brightness = 0.35 + Math.random() * 0.35;
          const tint = Math.random();
          const bColor = new THREE.Color(
            tint < 0.3 ? brightness * 0.7 : brightness * 0.85,
            tint < 0.3 ? brightness * 0.8 : brightness * 0.9,
            brightness
          );

          const bMat = new THREE.MeshPhongMaterial({
            color: bColor,
            shininess: 60 + Math.random() * 80,
            emissive: new THREE.Color(0.08, 0.06, 0.02),
            emissiveIntensity: isTall ? 0.3 : 0.1,
            specular: new THREE.Color(0.4, 0.4, 0.5),
          });

          const building = new THREE.Mesh(bGeo, bMat);
          building.position.set(bx, wy + bHeight / 2, bz);
          buildingGroup.add(building);

          // Add antenna/spire on tallest buildings
          if (isTall && bHeight > 0.15) {
            const spireGeo = new THREE.CylinderGeometry(0.0005, 0.001, 0.04, 4);
            const spireMat = new THREE.MeshBasicMaterial({ color: 0xcccccc });
            const spire = new THREE.Mesh(spireGeo, spireMat);
            spire.position.set(bx, wy + bHeight + 0.02, bz);
            buildingGroup.add(spire);
          }
        }

        // Add a subtle glow plane under the city
        const glowGeo = new THREE.PlaneGeometry(citySpread * 1.2, citySpread * 1.2);
        const glowMat = new THREE.MeshBasicMaterial({
          color: 0xffe8a0,
          transparent: true,
          opacity: 0.08,
          side: THREE.DoubleSide,
        });
        const glow = new THREE.Mesh(glowGeo, glowMat);
        glow.rotation.x = -Math.PI / 2;
        glow.position.set(wx, wy + 0.003, wz);
        buildingGroup.add(glow);

        scene.add(buildingGroup);
      }
    });

    // ─── Base box ───
    const baseGeo2 = new THREE.BoxGeometry(terrainW + 0.3, 0.06, terrainD + 0.3);
    const baseMat2 = new THREE.MeshBasicMaterial({ color: 0x16180f });
    const baseMesh = new THREE.Mesh(baseGeo2, baseMat2);
    baseMesh.position.y = -0.04;
    scene.add(baseMesh);

    // Side walls for depth
    const wallH = heightScale + 0.1;
    const wallMat = new THREE.MeshPhongMaterial({ color: 0x1e2118, shininess: 0 });
    [[0, wallH / 2 - 0.04, -(terrainD / 2 + 0.15), terrainW + 0.3, wallH, 0.01],
     [0, wallH / 2 - 0.04, terrainD / 2 + 0.15, terrainW + 0.3, wallH, 0.01],
     [-(terrainW / 2 + 0.15), wallH / 2 - 0.04, 0, 0.01, wallH, terrainD + 0.3],
     [terrainW / 2 + 0.15, wallH / 2 - 0.04, 0, 0.01, wallH, terrainD + 0.3]
    ].forEach(([px, py, pz, sx, sy, sz]) => {
      const wg = new THREE.BoxGeometry(sx, sy, sz);
      const wm = new THREE.Mesh(wg, wallMat);
      wm.position.set(px, py, pz);
      scene.add(wm);
    });

    // ─── Lighting ───
    scene.add(new THREE.AmbientLight(0xffffff, 0.45));
    const sun = new THREE.DirectionalLight(0xfff4e0, 0.85);
    sun.position.set(4, 6, 3);
    scene.add(sun);
    const fill = new THREE.DirectionalLight(0x8fb0c4, 0.25);
    fill.position.set(-3, 4, -2);
    scene.add(fill);

    // ─── Camera orbit ───
    const lookTarget = new THREE.Vector3(0, heightScale * 0.25, 0);

    const updateCamera = () => {
      const r = distance.current;
      const t = rotation.current.theta;
      const p = rotation.current.phi;
      camera.position.x = r * Math.sin(p) * Math.cos(t) + panOffset.current.x;
      camera.position.y = r * Math.cos(p);
      camera.position.z = r * Math.sin(p) * Math.sin(t) + panOffset.current.y;
      camera.lookAt(lookTarget.x + panOffset.current.x, lookTarget.y, lookTarget.z + panOffset.current.y);
    };
    updateCamera();

    let autoRotate = true;
    let rightDrag = false;
    let idleTimer = null;
    const IDLE_RESUME_MS = 3000;

    const pauseAutoRotate = () => {
      autoRotate = false;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => { autoRotate = true; }, IDLE_RESUME_MS);
    };

    const onDown = (e) => {
      if (e.button === 2) { rightDrag = true; } else { isDragging.current = true; }
      pauseAutoRotate();
      lastMouse.current = { x: e.clientX, y: e.clientY };
    };
    const onMove = (e) => {
      const dx = e.clientX - lastMouse.current.x;
      const dy = e.clientY - lastMouse.current.y;
      lastMouse.current = { x: e.clientX, y: e.clientY };
      if (isDragging.current) {
        rotation.current.theta -= dx * 0.004;
        rotation.current.phi = Math.max(0.15, Math.min(Math.PI * 0.48, rotation.current.phi + dy * 0.004));
        updateCamera();
      } else if (rightDrag) {
        panOffset.current.x += dx * 0.005;
        panOffset.current.y += dy * 0.005;
        updateCamera();
      }
    };
    const onUp = () => { isDragging.current = false; rightDrag = false; };
    const onWheel = (e) => {
      pauseAutoRotate();
      distance.current = Math.max(1.5, Math.min(10, distance.current + e.deltaY * 0.003));
      updateCamera();
    };
    const onContext = (e) => e.preventDefault();

    // Touch
    let lastTouchDist = 0;
    const onTouchStart = (e) => {
      pauseAutoRotate();
      if (e.touches.length === 1) {
        isDragging.current = true;
        lastMouse.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      } else if (e.touches.length === 2) {
        isDragging.current = false;
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        lastTouchDist = Math.sqrt(dx * dx + dy * dy);
      }
    };
    const onTouchMove = (e) => {
      e.preventDefault();
      if (e.touches.length === 1 && isDragging.current) {
        const dx = e.touches[0].clientX - lastMouse.current.x;
        const dy = e.touches[0].clientY - lastMouse.current.y;
        rotation.current.theta -= dx * 0.004;
        rotation.current.phi = Math.max(0.15, Math.min(Math.PI * 0.48, rotation.current.phi + dy * 0.004));
        lastMouse.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
        updateCamera();
      } else if (e.touches.length === 2) {
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (lastTouchDist > 0) {
          distance.current = Math.max(1.5, Math.min(10, distance.current - (dist - lastTouchDist) * 0.01));
          updateCamera();
        }
        lastTouchDist = dist;
      }
    };
    const onTouchEnd = () => { isDragging.current = false; lastTouchDist = 0; };

    const el = renderer.domElement;
    el.addEventListener("mousedown", onDown);
    el.addEventListener("mousemove", onMove);
    el.addEventListener("mouseup", onUp);
    el.addEventListener("mouseleave", onUp);
    el.addEventListener("wheel", onWheel, { passive: true });
    el.addEventListener("contextmenu", onContext);
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd);

    // ─── HTML Label overlay for landmarks ───
    const labelOverlay = document.createElement("div");
    labelOverlay.style.cssText = "position:absolute;inset:0;pointer-events:none;overflow:hidden;";
    container.style.position = "relative";
    container.appendChild(labelOverlay);

    // Store label DOM elements
    const labelEls = landmarks.map((lm, i) => {
      const gx = (lm.longitude - bounds.west) / lngRange;
      const gy = 1 - (lm.latitude - bounds.south) / latRange;
      const wx = gx * terrainW - terrainW / 2;
      const wz = -(gy * terrainD - terrainD / 2);
      const normalized = (lm.elevation_m - globalMin) / elevRange;
      const wy = normalized * heightScale + 0.2 + normalized * 0.15;

      const typeColors = {
        peak: "#d4b87a", volcano: "#e06040", valley: "#4a9f7b", water: "#5aafdd",
        city: "#c8b8e8", canyon: "#d08a4a", pass: "#8aaa6a", plateau: "#aa9060", ridge: "#b8a060",
        skyline: "#e8c060",
      };
      const color = typeColors[lm.type] || "#e8dcc8";
      const isPrimary = lm.type === "peak" || lm.type === "volcano" || lm.type === "city" || lm.type === "skyline";

      const el = document.createElement("div");
      el.style.cssText = `position:absolute;transform:translate(-50%,-100%);white-space:nowrap;transition:opacity 0.2s;`;
      el.innerHTML = `
        <div style="display:flex;flex-direction:column;align-items:center;">
          <div style="
            background:rgba(18,20,15,0.85);
            border:1px solid ${color}44;
            border-radius:6px;
            padding:${isPrimary ? "4px 10px" : "3px 7px"};
            backdrop-filter:blur(4px);
            margin-bottom:2px;
          ">
            <div style="
              font-family:'IBM Plex Mono',monospace;
              font-size:${isPrimary ? "11px" : "9px"};
              font-weight:${isPrimary ? "600" : "500"};
              color:${color};
              letter-spacing:0.5px;
              line-height:1.3;
            ">${lm.name}</div>
            <div style="
              font-family:'IBM Plex Mono',monospace;
              font-size:${isPrimary ? "10px" : "8px"};
              color:${color}99;
              margin-top:1px;
            ">${Math.round(lm.elevation_m * M_TO_FT).toLocaleString()} ft</div>
          </div>
          <div style="width:1px;height:${isPrimary ? "12px" : "8px"};background:${color}66;"></div>
          <div style="width:5px;height:5px;border-radius:50%;background:${color};box-shadow:0 0 6px ${color}88;"></div>
        </div>`;
      labelOverlay.appendChild(el);

      return { el, worldPos: new THREE.Vector3(wx, wy, wz) };
    });

    // Project labels to screen each frame
    const projectLabels = () => {
      const w2 = W / 2, h2 = H / 2;
      labelEls.forEach(({ el, worldPos }) => {
        const projected = worldPos.clone().project(camera);
        if (projected.z > 1 || projected.z < -1) {
          el.style.opacity = "0";
          return;
        }
        const sx = (projected.x * w2) + w2;
        const sy = -(projected.y * h2) + h2;
        el.style.left = sx + "px";
        el.style.top = sy + "px";
        // Fade labels that are behind or at edge
        const edgeDist = Math.min(sx, W - sx, sy, H - sy);
        el.style.opacity = edgeDist < 30 ? "0" : projected.z > 0.999 ? "0.3" : "1";
      });
    };

    const animate = () => {
      frameRef.current = requestAnimationFrame(animate);
      if (autoRotate) { rotation.current.theta += 0.0008; updateCamera(); }
      renderer.render(scene, camera);
      projectLabels();
    };
    animate();

    const onResize = () => {
      const w = container.clientWidth, h = container.clientHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    window.addEventListener("resize", onResize);

    return () => {
      cancelAnimationFrame(frameRef.current);
      if (idleTimer) clearTimeout(idleTimer);
      window.removeEventListener("resize", onResize);
      if (labelOverlay.parentNode) labelOverlay.parentNode.removeChild(labelOverlay);
      renderer.dispose();
    };
  }, [regionData]);

  return <div ref={containerRef} style={{ width: "100%", height: "100%", cursor: "grab" }} />;
}

// ─── Main App ───
export default function TopoScope() {
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [history, setHistory] = useState([]);
  const [selectedLandmark, setSelectedLandmark] = useState(null);
  const [retryCount, setRetryCount] = useState(0);
  const inputRef = useRef(null);

  const callAPI = async (searchQuery) => {
    const body = JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4000,
      messages: [{
        role: "user",
        content: `Regional topographic data for: "${searchQuery}"

Cover a WIDE area of ~400-500km across. Make bounds large enough to see the full region. Return ONLY valid JSON, no other text. No apostrophes or special chars in string values. Keep all strings under 12 words.

{"region_name":"name","description":"overview max 12 words","bounds":{"north":0,"south":0,"east":0,"west":0},"base_elevation":0,"landmarks":[{"name":"str","latitude":0,"longitude":0,"elevation_m":0,"type":"peak|valley|city|water|volcano|pass|canyon|plateau|ridge|skyline","influence_radius":0.15,"description":"max 10 words","buildings":false}],"elevation_stats":{"min_m":0,"max_m":0,"mean_m":0},"geological_summary":"max 12 words","climate_summary":"max 10 words"}

Type must be one of: peak, valley, city, water, volcano, pass, canyon, plateau, ridge, skyline.
Use type "skyline" for major cities with tall buildings (NYC, Chicago, Dubai, Hong Kong, etc) and set "buildings":true.
Include 14-20 landmarks with accurate lat/lng within bounds. influence_radius: 0.05-0.4 (bigger for larger features). Good spatial spread is essential. Bounds should span ~4-5 degrees lat/lng. For Seattle: include Bellingham, Olympics, Rainier, Puget Sound, SeaTac, Cascades, Mt Baker etc across the whole PNW. For Everest: include many Himalayan peaks, valleys, passes across a wide area. For NYC: mark Manhattan as skyline type with buildings:true.`
      }]
    });

    const MAX_RETRIES = 3;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const response = await fetch("/api/claude", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });

      if (response.status === 429) {
        if (attempt >= MAX_RETRIES) throw new Error("Rate limited. Please wait a moment and try again.");
        const wait = Math.pow(2, attempt + 1) * 1000 + Math.random() * 1000;
        setRetryCount(attempt + 1);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }

      if (!response.ok) throw new Error(`API error ${response.status}`);
      setRetryCount(0);
      return await response.json();
    }
  };

  const fetchRegion = useCallback(async (searchQuery) => {
    if (!searchQuery.trim()) return;
    setLoading(true);
    setError(null);
    setResult(null);
    setSelectedLandmark(null);
    setRetryCount(0);

    try {
      const data = await callAPI(searchQuery);
      const text = data.content?.filter(b => b.type === "text").map(b => b.text).join("") || "";
      if (!text) throw new Error("Empty response");

      // ─── Robust JSON extraction ───
      let rawJson = text.replace(/```json\s*/g, "").replace(/```/g, "").trim();
      // Strip control characters that break JSON
      rawJson = rawJson.replace(/[\x00-\x1F\x7F]/g, (ch) => ch === "\n" || ch === "\t" ? " " : "");

      // Find outermost braces
      let depth = 0, jStart = -1, jEnd = -1;
      for (let i = 0; i < rawJson.length; i++) {
        if (rawJson[i] === "{") { if (depth === 0) jStart = i; depth++; }
        else if (rawJson[i] === "}") { depth--; if (depth === 0) { jEnd = i + 1; break; } }
      }

      let jsonStr;
      if (jStart >= 0 && jEnd > jStart) {
        jsonStr = rawJson.substring(jStart, jEnd);
      } else if (jStart >= 0) {
        // Truncated — take what we have and repair
        jsonStr = rawJson.substring(jStart);
      } else {
        throw new Error("No JSON object found in response");
      }

      // Try direct parse first
      let parsed;
      try { parsed = JSON.parse(jsonStr); } catch(directErr) {
        // Repair: close unclosed strings, arrays, objects
        let s = jsonStr;
        // Remove trailing incomplete entries
        s = s.replace(/,\s*"[^"]*"?\s*:?\s*"?[^"]*$/, "");
        s = s.replace(/,\s*\{[^}]*$/, "");
        s = s.replace(/,\s*$/, "");
        // Remove trailing commas before closers
        s = s.replace(/,\s*([}\]])/g, "$1");

        // Count open structures (respecting strings)
        let ob = 0, oq = 0, inStr = false, esc = false;
        for (let i = 0; i < s.length; i++) {
          const c = s[i];
          if (esc) { esc = false; continue; }
          if (c === "\\") { esc = true; continue; }
          if (c === '"') { inStr = !inStr; continue; }
          if (inStr) continue;
          if (c === "{") ob++; else if (c === "}") ob--;
          if (c === "[") oq++; else if (c === "]") oq--;
        }
        if (inStr) s += '"';
        // Remove another pass of trailing partials after closing string
        s = s.replace(/,\s*"[^"]*"?\s*:?\s*"?[^"]*$/, "");
        s = s.replace(/,\s*([}\]])/g, "$1");
        // Recount
        ob = 0; oq = 0; inStr = false; esc = false;
        for (let i = 0; i < s.length; i++) {
          const c = s[i];
          if (esc) { esc = false; continue; }
          if (c === "\\") { esc = true; continue; }
          if (c === '"') { inStr = !inStr; continue; }
          if (inStr) continue;
          if (c === "{") ob++; else if (c === "}") ob--;
          if (c === "[") oq++; else if (c === "]") oq--;
        }
        for (let i = 0; i < oq; i++) s += "]";
        for (let i = 0; i < ob; i++) s += "}";
        s = s.replace(/,\s*([}\]])/g, "$1");

        try { parsed = JSON.parse(s); } catch(repairErr) {
          // Last resort: extract landmarks array and bounds via regex
          const lmMatch = s.match(/"landmarks"\s*:\s*\[/);
          const bnMatch = s.match(/"bounds"\s*:\s*\{([\s\S]*?)\}/);
          const nmMatch = s.match(/"region_name"\s*:\s*"([^"]*)"/);

          if (lmMatch && bnMatch) {
            // Extract individual landmark objects
            const lmStart = s.indexOf(lmMatch[0]) + lmMatch[0].length;
            const lmSection = s.substring(lmStart);
            const landmarkObjects = [];
            const objRegex = /\{[^{}]*\}/g;
            let m;
            while ((m = objRegex.exec(lmSection)) !== null) {
              try {
                const obj = JSON.parse(m[0]);
                if (obj.name && obj.latitude != null) landmarkObjects.push(obj);
              } catch(e) { /* skip malformed */ }
            }

            parsed = {
              region_name: nmMatch ? nmMatch[1] : searchQuery,
              description: "",
              bounds: JSON.parse("{" + bnMatch[1] + "}"),
              base_elevation: 0,
              landmarks: landmarkObjects,
              elevation_stats: { min_m: 0, max_m: 0, mean_m: 0 },
              geological_summary: "",
              climate_summary: "",
            };
          } else {
            throw new Error("Could not parse response. Please try again.");
          }
        }
      }

      if (!parsed.landmarks || !parsed.bounds) throw new Error("Incomplete data — try again");

      // Validate landmarks
      parsed.landmarks = parsed.landmarks.filter(lm =>
        lm && typeof lm.latitude === "number" && typeof lm.longitude === "number" &&
        typeof lm.elevation_m === "number" && lm.name
      ).map(lm => ({
        ...lm,
        influence_radius: Math.max(0.05, Math.min(0.4, lm.influence_radius || 0.15)),
        type: lm.type || "peak",
        description: lm.description || "",
      }));

      if (parsed.landmarks.length < 2) throw new Error("Not enough landmark data — try again");

      // Ensure elevation_stats
      const elevs = parsed.landmarks.map(l => l.elevation_m);
      if (!parsed.elevation_stats || !parsed.elevation_stats.max_m) {
        parsed.elevation_stats = {
          min_m: Math.min(...elevs),
          max_m: Math.max(...elevs),
          mean_m: Math.round(elevs.reduce((a, b) => a + b, 0) / elevs.length),
        };
      }
      if (parsed.base_elevation == null) {
        parsed.base_elevation = Math.max(0, Math.min(...elevs));
      }

      setResult(parsed);
      setHistory(prev => [{ name: parsed.region_name, query: searchQuery }, ...prev].slice(0, 10));
    } catch (e) {
      console.error(e);
      setError(`Failed to fetch regional data: ${e.message}`);
    }
    setLoading(false);
  }, []);

  useEffect(() => { inputRef.current?.focus(); }, []);

  return (
    <div style={S.root}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Serif+Display&family=IBM+Plex+Mono:wght@400;500;600&family=Outfit:wght@300;400;500;600;700&display=swap');
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes fadeUp { from { opacity:0; transform:translateY(16px); } to { opacity:1; transform:translateY(0); } }
        @keyframes pulse { 0%,100% { opacity:0.4; } 50% { opacity:1; } }
        @keyframes shimmer { 0% { background-position:-200% 0; } 100% { background-position:200% 0; } }
        * { box-sizing:border-box; margin:0; padding:0; }
        ::-webkit-scrollbar { width:5px; }
        ::-webkit-scrollbar-track { background:transparent; }
        ::-webkit-scrollbar-thumb { background:#2f332a; border-radius:3px; }
        input:focus { border-color:#6b8f4a !important; box-shadow:0 0 0 3px rgba(107,143,74,0.15) !important; }
      `}</style>

      {/* ── Sidebar ── */}
      <aside style={S.sidebar}>
        <div style={S.brand}>
          <div style={S.brandRow}>
            <div style={S.brandIcon}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round"><path d="M12 2L2 22h20L12 2z"/><path d="M7 14h10" opacity=".5"/></svg>
            </div>
            <span style={S.brandName}>TopoScope</span>
          </div>
          <div style={S.brandTag}>Regional 3D Terrain</div>
        </div>

        <div style={S.searchSection}>
          <div style={{ position: "relative" }}>
            <span style={S.inputIcon}>⌕</span>
            <input ref={inputRef} type="text" value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => e.key === "Enter" && fetchRegion(query)}
              placeholder="Search a region, city, or mountain…"
              style={S.input} />
          </div>
          <button style={{ ...S.searchBtn, opacity: loading ? 0.5 : 1, cursor: loading ? "wait" : "pointer" }}
            onClick={() => fetchRegion(query)} disabled={loading}>
            {loading ? "⏳ Loading Region…" : "Explore Region"}
          </button>
          <div style={S.searchHint}>Searches a ~400-500km region around your query</div>
        </div>

        <div style={S.section}>
          <div style={S.sectionLabel}>Quick Explore</div>
          <div style={S.quickGrid}>
            {QUICK.map(p => (
              <button key={p.label} style={S.quickBtn}
                onClick={() => { setQuery(p.label); fetchRegion(p.q); }}
                onMouseEnter={e => { e.currentTarget.style.background = "#2f332a"; e.currentTarget.style.borderColor = "#6b8f4a"; e.currentTarget.style.color = "#c8c0b4"; }}
                onMouseLeave={e => { e.currentTarget.style.background = "#232620"; e.currentTarget.style.borderColor = "#2a2d25"; e.currentTarget.style.color = "#6b6558"; }}
              >{p.label}</button>
            ))}
          </div>
        </div>

        {/* Landmark list when result is loaded */}
        {result && (
          <div style={S.section}>
            <div style={S.sectionLabel}>Landmarks ({result.landmarks.length})</div>
            <div style={{ maxHeight: 220, overflowY: "auto" }}>
              {result.landmarks.map((lm, i) => {
                const isActive = selectedLandmark === i;
                const typeColors = { peak: "#d4b87a", volcano: "#c75a3a", valley: "#4a9f7b", water: "#4a8fbb", city: "#b8a8d8", canyon: "#c87a4a", pass: "#8aaa6a", plateau: "#aa9060", ridge: "#9a8a5a", skyline: "#e8c060" };
                return (
                  <div key={i}
                    onClick={() => setSelectedLandmark(isActive ? null : i)}
                    style={{ ...S.landmarkItem, background: isActive ? "#2a2d25" : "transparent", borderLeft: `3px solid ${typeColors[lm.type] || "#6b8f4a"}` }}
                    onMouseEnter={e => { if (!isActive) e.currentTarget.style.background = "#232620"; }}
                    onMouseLeave={e => { if (!isActive) e.currentTarget.style.background = "transparent"; }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <span style={{ fontSize: 12, color: isActive ? "#e8dcc8" : "#8a8374", fontWeight: isActive ? 600 : 400 }}>{lm.name}</span>
                      <span style={{ fontFamily: "monospace", fontSize: 10, color: typeColors[lm.type] || "#6b8f4a" }}>{toFt(lm.elevation_m)} ft</span>
                    </div>
                    {isActive && (
                      <div style={{ marginTop: 6, fontSize: 11, color: "#6b6558", lineHeight: 1.5 }}>
                        {lm.description}<br/>
                        <span style={{ fontFamily: "monospace", fontSize: 10, color: "#555" }}>
                          {lm.latitude?.toFixed(3)}°, {lm.longitude?.toFixed(3)}° · {lm.type}
                        </span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {history.length > 0 && (
          <div style={S.section}>
            <div style={S.sectionLabel}>Recent</div>
            {history.map((h, i) => (
              <div key={i} style={S.historyItem}
                onClick={() => { setQuery(h.name); fetchRegion(h.query); }}
                onMouseEnter={e => e.currentTarget.style.background = "#232620"}
                onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                <span style={{ color: "#4a6741", marginRight: 8, fontSize: 9 }}>▲</span>
                <span style={{ fontSize: 11, color: "#6b6558" }}>{h.name}</span>
              </div>
            ))}
          </div>
        )}

        <div style={{ ...S.section, marginTop: "auto" }}>
          <div style={S.sectionLabel}>Data Sources</div>
          {RESOURCES.map(r => (
            <a key={r.name} href={r.url} target="_blank" rel="noreferrer" style={S.resourceLink}
              onMouseEnter={e => e.currentTarget.style.background = "#232620"}
              onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
              <div style={{ width: 6, height: 6, borderRadius: "50%", background: r.color, flexShrink: 0 }} />
              <span style={{ fontSize: 11, color: "#6b6558" }}>{r.name}</span>
              <span style={{ fontSize: 10, color: "#3d4236", marginLeft: "auto" }}>→</span>
            </a>
          ))}
        </div>
      </aside>

      {/* ── Main ── */}
      <main style={S.main}>
        {loading ? (
          <div style={S.center}>
            <div style={S.spinner} />
            <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 14, color: "#8a8374", marginTop: 20, animation: "pulse 1.5s ease infinite" }}>Loading regional terrain…</div>
            <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, color: "#4a4a40", marginTop: 8 }}>
              {retryCount > 0 ? `Rate limited — retrying (attempt ${retryCount}/3)…` : "Fetching elevation data for the full region"}
            </div>
            <div style={{ width: 180, height: 2, borderRadius: 1, marginTop: 20, background: "linear-gradient(90deg, transparent, #6b8f4a, transparent)", backgroundSize: "200% 100%", animation: "shimmer 1.5s infinite" }} />
          </div>
        ) : result ? (
          <div style={{ display: "flex", flexDirection: "column", height: "100%", animation: "fadeUp 0.5s ease" }}>
            {/* 3D View */}
            <div style={S.terrainBox}>
              <RegionalTerrain3D regionData={result} />
              <div style={S.terrainOverlay}>
                <div style={S.terrainTitle}>{result.region_name}</div>
                <div style={S.terrainSub}>
                  {toFt(result.elevation_stats?.min_m)} ft – {toFt(result.elevation_stats?.max_m)} ft elevation range
                </div>
              </div>
              <div style={S.controlsHint}>Drag to rotate · Scroll to zoom · Right-drag to pan</div>
            </div>

            {/* Bottom info panel */}
            <div style={S.infoPanel}>
              <div style={S.infoGrid}>
                <div style={S.infoCard}>
                  <div style={S.infoLabel}>Region Overview</div>
                  <div style={S.infoText}>{result.description}</div>
                </div>
                <div style={S.infoCard}>
                  <div style={S.infoLabel}>Geology</div>
                  <div style={S.infoText}>{result.geological_summary}</div>
                </div>
                <div style={S.infoCard}>
                  <div style={S.infoLabel}>Climate</div>
                  <div style={S.infoText}>{result.climate_summary}</div>
                </div>
                <div style={S.infoCard}>
                  <div style={S.infoLabel}>Elevation Stats</div>
                  <div style={{ display: "flex", gap: 16, marginTop: 4 }}>
                    <div>
                      <div style={{ fontFamily: "monospace", fontSize: 9, color: "#555", textTransform: "uppercase" }}>Min</div>
                      <div style={{ fontFamily: "monospace", fontSize: 14, color: "#4a9f7b", fontWeight: 600 }}>{toFt(result.elevation_stats?.min_m)} ft</div>
                    </div>
                    <div>
                      <div style={{ fontFamily: "monospace", fontSize: 9, color: "#555", textTransform: "uppercase" }}>Mean</div>
                      <div style={{ fontFamily: "monospace", fontSize: 14, color: "#8a8374", fontWeight: 600 }}>{toFt(result.elevation_stats?.mean_m)} ft</div>
                    </div>
                    <div>
                      <div style={{ fontFamily: "monospace", fontSize: 9, color: "#555", textTransform: "uppercase" }}>Max</div>
                      <div style={{ fontFamily: "monospace", fontSize: 14, color: "#d4b87a", fontWeight: 600 }}>{toFt(result.elevation_stats?.max_m)} ft</div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        ) : error ? (
          <div style={S.center}>
            <div style={{ fontSize: 36, opacity: 0.3, marginBottom: 12 }}>⚠</div>
            <div style={{ fontSize: 14, color: "#8a8374" }}>{error}</div>
          </div>
        ) : (
          <div style={S.center}>
            <svg width="90" height="90" viewBox="0 0 100 60" fill="none" stroke="#2a2d25" strokeWidth="1.5">
              <path d="M0 55 L20 25 L35 40 L55 10 L75 35 L100 15 L100 55 Z" fill="#1e2118" stroke="#2a2d25"/>
              <path d="M0 55 L20 25 L35 40 L55 10 L75 35 L100 15" strokeDasharray="3 3" opacity="0.5"/>
              <path d="M10 42 L30 32 L50 22 L70 28 L90 20" stroke="#3d4236" strokeDasharray="2 4" opacity="0.3"/>
              <path d="M5 48 L25 38 L45 28 L65 32 L85 25" stroke="#3d4236" strokeDasharray="2 4" opacity="0.2"/>
            </svg>
            <div style={{ fontFamily: "'DM Serif Display', serif", fontSize: 30, color: "#c8c0b4", marginTop: 24 }}>Regional Terrain Explorer</div>
            <div style={{ fontSize: 14, color: "#555", textAlign: "center", maxWidth: 460, lineHeight: 1.7, marginTop: 12 }}>
              Search for any location to generate an interactive 3D terrain model of the surrounding region — complete with contour lines, landmark pins, and elevation data.
            </div>
            <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, color: "#4a6741", padding: "8px 16px", background: "rgba(107,143,74,0.06)", borderRadius: 8, border: "1px solid rgba(107,143,74,0.1)", marginTop: 20 }}>
              Try "Seattle Region", "New York City", or "Swiss Alps"
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

const S = {
  root: { display: "grid", gridTemplateColumns: "340px 1fr", height: "100vh", background: "#12140f", fontFamily: "'Outfit', sans-serif", color: "#e8dcc8", overflow: "hidden" },
  sidebar: { background: "#1a1c16", borderRight: "1px solid #252820", display: "flex", flexDirection: "column", overflowY: "auto" },
  brand: { padding: "24px 20px 0" },
  brandRow: { display: "flex", alignItems: "center", gap: 10 },
  brandIcon: { width: 36, height: 36, background: "linear-gradient(135deg, #6b8f4a, #a67c52)", borderRadius: 9, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 },
  brandName: { fontFamily: "'DM Serif Display', serif", fontSize: 24, color: "#e8dcc8" },
  brandTag: { fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, color: "#4a4a40", letterSpacing: 2, textTransform: "uppercase", marginTop: 4, paddingLeft: 46 },
  searchSection: { padding: "20px 20px 12px" },
  inputIcon: { position: "absolute", left: 13, top: "50%", transform: "translateY(-50%)", color: "#4a4a40", fontSize: 14, pointerEvents: "none", zIndex: 1 },
  input: { width: "100%", padding: "12px 14px 12px 38px", background: "#222520", border: "1px solid #2a2d25", borderRadius: 10, color: "#e8dcc8", fontFamily: "'Outfit', sans-serif", fontSize: 13, outline: "none", transition: "all 0.2s" },
  searchBtn: { marginTop: 8, width: "100%", padding: "11px 14px", background: "linear-gradient(135deg, #6b8f4a, #5a7a3f)", border: "none", borderRadius: 9, color: "white", fontFamily: "'Outfit', sans-serif", fontSize: 13, fontWeight: 600 },
  searchHint: { fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, color: "#3d3d35", marginTop: 6 },
  section: { padding: "0 20px 14px" },
  sectionLabel: { fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, color: "#4a4a40", textTransform: "uppercase", letterSpacing: 2, marginBottom: 8 },
  quickGrid: { display: "flex", flexWrap: "wrap", gap: 5 },
  quickBtn: { padding: "6px 10px", background: "#232620", border: "1px solid #2a2d25", borderRadius: 6, color: "#6b6558", fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, cursor: "pointer", transition: "all 0.15s" },
  landmarkItem: { padding: "8px 10px", borderRadius: "0 6px 6px 0", cursor: "pointer", transition: "background 0.15s", marginBottom: 2 },
  historyItem: { display: "flex", alignItems: "center", padding: "6px 8px", borderRadius: 6, cursor: "pointer", transition: "background 0.15s" },
  resourceLink: { display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", borderRadius: 6, textDecoration: "none", color: "inherit", transition: "background 0.15s", cursor: "pointer" },
  main: { overflow: "hidden", position: "relative", background: "#12140f" },
  center: { display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", padding: 40 },
  spinner: { width: 36, height: 36, border: "3px solid #252820", borderTopColor: "#6b8f4a", borderRadius: "50%", animation: "spin 0.8s linear infinite" },
  terrainBox: { position: "relative", flex: 1, minHeight: 0, borderBottom: "1px solid #252820" },
  terrainOverlay: { position: "absolute", bottom: 16, left: 20, zIndex: 10 },
  terrainTitle: { fontFamily: "'DM Serif Display', serif", fontSize: 26, color: "white", textShadow: "0 2px 20px rgba(0,0,0,0.8)" },
  terrainSub: { fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, color: "rgba(255,255,255,0.45)", letterSpacing: 1, marginTop: 2 },
  controlsHint: { position: "absolute", top: 12, right: 14, fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, color: "rgba(255,255,255,0.2)", background: "rgba(0,0,0,0.3)", padding: "4px 10px", borderRadius: 5 },
  infoPanel: { padding: "16px 20px", background: "#16180f", borderTop: "1px solid #1e2118", flexShrink: 0 },
  infoGrid: { display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 12 },
  infoCard: { background: "#1a1c16", borderRadius: 10, padding: 14, border: "1px solid #222520" },
  infoLabel: { fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, color: "#4a4a40", textTransform: "uppercase", letterSpacing: 1.5, marginBottom: 6 },
  infoText: { fontSize: 12, color: "#6b6558", lineHeight: 1.6 },
};
