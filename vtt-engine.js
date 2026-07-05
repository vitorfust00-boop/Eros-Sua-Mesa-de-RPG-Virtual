class VTTEngine {
    constructor(canvasId) {
        this.canvas = document.getElementById(canvasId);
        this.ctx = this.canvas.getContext('2d');
        
        this.mapImage = new Image();
        this.hasMap = false;
        
        this.tokens = []; // {id, x, y, src, img, isAlly, isLocked, size, label}
        this.walls = [];  // {x1, y1, x2, y2}
        
        this.pan = { x: 0, y: 0 };
        this.zoom = 1;
        this.isDM = false;
        
        this.isDragging = false;
        this.dragToken = null;
        this.isDrawingWall = false;
        this.wallStart = null;
        
        this.toolMode = 'pan'; // pan, draw_wall, erase_wall, magic_wand, token_move
        this.hoveredWall = null;
        this.hoveredToken = null;

        this.onStateChange = null; // Callback for MQTT sync

        this.setupEvents();
        this.loop();
    }

    setMap(base64) {
        if(!base64) { this.hasMap = false; return; }
        this.mapImage.onload = () => {
            this.hasMap = true;
            // Center map on load
            this.pan.x = (this.canvas.width - this.mapImage.width * this.zoom) / 2;
            this.pan.y = (this.canvas.height - this.mapImage.height * this.zoom) / 2;
        };
        this.mapImage.src = base64;
    }

    setTokens(tokensArray) {
        // tokensArray: [{id, x, y, src, isAlly, isLocked, size, label}]
        this.tokens = tokensArray.map(t => {
            let img = new Image();
            img.src = t.src;
            return { ...t, img: img };
        });
    }

    setWalls(wallsArray) {
        this.walls = wallsArray;
    }

    // --- Core Math & Raycasting ---
    getIntersection(ray, segment) {
        let r_px = ray.x, r_py = ray.y, r_dx = ray.dx, r_dy = ray.dy;
        let s_px = segment.x1, s_py = segment.y1, s_dx = segment.x2 - segment.x1, s_dy = segment.y2 - segment.y1;
        let T2 = r_dx * s_dy - r_dy * s_dx;
        if (Math.abs(T2) < 0.001) return null;
        let T1 = (s_px - r_px) * s_dy - (s_py - r_py) * s_dx;
        let U = (s_px - r_px) * r_dy - (s_py - r_py) * r_dx;
        let t = T1 / T2;
        let u = U / T2;
        if (t > 0 && u >= 0 && u <= 1) {
            return { x: r_px + r_dx * t, y: r_py + r_dy * t, param: t };
        }
        return null;
    }

    getSightPolygon(cx, cy) {
        if(!this.hasMap) return [];
        const width = this.mapImage.width;
        const height = this.mapImage.height;
        const allWalls = [
            ...this.walls,
            {x1:0,y1:0, x2:width,y2:0},
            {x1:width,y1:0, x2:width,y2:height},
            {x1:width,y1:height, x2:0,y2:height},
            {x1:0,y1:height, x2:0,y2:0}
        ];

        let uniquePoints = [];
        allWalls.forEach(w => {
            [[w.x1, w.y1], [w.x2, w.y2]].forEach(p => {
                if (!uniquePoints.some(up => Math.abs(up.x - p[0]) < 1 && Math.abs(up.y - p[1]) < 1)) {
                    uniquePoints.push({x: p[0], y: p[1]});
                }
            });
        });

        let angles = [];
        uniquePoints.forEach(p => {
            let angle = Math.atan2(p.y - cy, p.x - cx);
            angles.push(angle - 0.0001, angle, angle + 0.0001);
        });

        let intersects = [];
        angles.forEach(angle => {
            let ray = {x: cx, y: cy, dx: Math.cos(angle), dy: Math.sin(angle)};
            let closestIntersect = null;
            let minT1 = Infinity;

            allWalls.forEach(w => {
                let intersect = this.getIntersection(ray, w);
                if (intersect && intersect.param < minT1) {
                    minT1 = intersect.param;
                    closestIntersect = intersect;
                }
            });
            if (closestIntersect) {
                closestIntersect.angle = angle;
                intersects.push(closestIntersect);
            }
        });

        intersects.sort((a,b) => a.angle - b.angle);
        return intersects;
    }

    // --- Magic Wand AI (Flood Fill + Edge Detection) ---
    magicWand(startX, startY) {
        if(!this.hasMap) return;
        
        // Draw map to an offscreen canvas to get pixels
        const off = document.createElement('canvas');
        off.width = this.mapImage.width;
        off.height = this.mapImage.height;
        const octx = off.getContext('2d');
        octx.drawImage(this.mapImage, 0, 0);
        
        const imgData = octx.getImageData(0, 0, off.width, off.height);
        const data = imgData.data;
        const w = off.width;
        const h = off.height;
        
        const getIdx = (x, y) => (y * w + x) * 4;
        const sx = Math.floor(startX);
        const sy = Math.floor(startY);
        if(sx<0 || sy<0 || sx>=w || sy>=h) return;

        const sIdx = getIdx(sx, sy);
        const targetR = data[sIdx], targetG = data[sIdx+1], targetB = data[sIdx+2];

        // Se clicar no branco (fundo), aborta para no travar
        if (targetR > 200 && targetG > 200 && targetB > 200) {
            alert("A IA s detecta paredes escuras/coloridas. Voc clicou em uma rea muito clara.");
            return;
        }

        const visited = new Uint8Array(w * h);
        const stack = [[sx, sy]];
        let points = [];

        const colorMatch = (x, y) => {
            const idx = getIdx(x, y);
            const dr = data[idx] - targetR;
            const dg = data[idx+1] - targetG;
            const db = data[idx+2] - targetB;
            return (dr*dr + dg*dg + db*db) < 4000; // Tolerance
        };

        // Flood Fill
        while(stack.length > 0) {
            const [x, y] = stack.pop();
            const vIdx = y * w + x;
            if(visited[vIdx]) continue;
            
            if(colorMatch(x, y)) {
                visited[vIdx] = 1;
                points.push({x, y});
                if(x > 0) stack.push([x-1, y]);
                if(x < w-1) stack.push([x+1, y]);
                if(y > 0) stack.push([x, y-1]);
                if(y < h-1) stack.push([x, y+1]);
            }
        }

        if(points.length < 10) return; // Too small

        // Find boundary pixels
        let boundary = [];
        points.forEach(p => {
            const isBoundary = 
                p.x===0 || p.x===w-1 || p.y===0 || p.y===h-1 ||
                !visited[(p.y-1)*w + p.x] || !visited[(p.y+1)*w + p.x] ||
                !visited[p.y*w + p.x-1] || !visited[p.y*w + p.x+1];
            if(isBoundary) boundary.push(p);
        });

        // Simplicar e transformar em paredes
        // Como o ramer-douglas-peucker numa nuvem de pontos  difcil, 
        // vamos fazer um grid sampling rudimentar
        const gridSize = 20;
        let grid = {};
        boundary.forEach(p => {
            const gx = Math.floor(p.x / gridSize) * gridSize;
            const gy = Math.floor(p.y / gridSize) * gridSize;
            const key = `${gx},${gy}`;
            grid[key] = {x:gx, y:gy};
        });

        const newWalls = [];
        const nodes = Object.values(grid);
        // Create edges between adjacent nodes
        for(let i=0; i<nodes.length; i++) {
            for(let j=i+1; j<nodes.length; j++) {
                const n1 = nodes[i];
                const n2 = nodes[j];
                const dist = Math.hypot(n1.x - n2.x, n1.y - n2.y);
                if (dist > 0 && dist <= gridSize * 1.5) {
                    newWalls.push({x1: n1.x, y1: n1.y, x2: n2.x, y2: n2.y});
                }
            }
        }

        this.walls.push(...newWalls);
        this.notifyStateChange();
    }

    notifyStateChange() {
        if (this.onStateChange) {
            this.onStateChange({
                tokens: this.tokens.map(t => ({id: t.id, x: t.x, y: t.y, src: t.src, isAlly: t.isAlly, isLocked: t.isLocked, size: t.size, label: t.label})),
                walls: this.walls
            });
        }
    }

    // --- Input Handling ---
    screenToWorld(sx, sy) {
        return {
            x: (sx - this.pan.x) / this.zoom,
            y: (sy - this.pan.y) / this.zoom
        };
    }

    setupEvents() {
        let isMouseDown = false;
        let lastMouse = {x:0, y:0};

        this.canvas.addEventListener('wheel', (e) => {
            e.preventDefault();
            const mouseX = e.offsetX;
            const mouseY = e.offsetY;
            const zoomAmount = e.deltaY > 0 ? 0.9 : 1.1;
            
            this.pan.x = mouseX - (mouseX - this.pan.x) * zoomAmount;
            this.pan.y = mouseY - (mouseY - this.pan.y) * zoomAmount;
            this.zoom *= zoomAmount;
        });

        this.canvas.addEventListener('mousedown', (e) => {
            isMouseDown = true;
            lastMouse = {x: e.offsetX, y: e.offsetY};
            const world = this.screenToWorld(e.offsetX, e.offsetY);

            if (this.toolMode === 'pan') {
                // Check if clicking a token
                for (let i = this.tokens.length - 1; i >= 0; i--) {
                    const t = this.tokens[i];
                    const dist = Math.hypot(world.x - t.x, world.y - t.y);
                    if (dist < t.size/2) {
                        if (this.isDM || !t.isLocked) {
                            this.isDragging = true;
                            this.dragToken = t;
                            return;
                        }
                    }
                }
            } else if (this.toolMode === 'draw_wall' && this.isDM) {
                this.isDrawingWall = true;
                this.wallStart = world;
            } else if (this.toolMode === 'erase_wall' && this.isDM) {
                // Find closest wall
                let closest = -1;
                let minDist = 15 / this.zoom;
                for(let i=0; i<this.walls.length; i++) {
                    const w = this.walls[i];
                    // Distance point to line segment
                    const l2 = Math.pow(w.x2 - w.x1, 2) + Math.pow(w.y2 - w.y1, 2);
                    let t = Math.max(0, Math.min(1, ((world.x - w.x1) * (w.x2 - w.x1) + (world.y - w.y1) * (w.y2 - w.y1)) / l2));
                    const proj = { x: w.x1 + t * (w.x2 - w.x1), y: w.y1 + t * (w.y2 - w.y1) };
                    const dist = Math.hypot(world.x - proj.x, world.y - proj.y);
                    if (dist < minDist) {
                        minDist = dist;
                        closest = i;
                    }
                }
                if (closest >= 0) {
                    this.walls.splice(closest, 1);
                    this.notifyStateChange();
                }
            } else if (this.toolMode === 'magic_wand' && this.isDM) {
                this.magicWand(world.x, world.y);
            }
        });

        this.canvas.addEventListener('mousemove', (e) => {
            const world = this.screenToWorld(e.offsetX, e.offsetY);
            if (isMouseDown) {
                if (this.isDragging && this.dragToken) {
                    this.dragToken.x = world.x;
                    this.dragToken.y = world.y;
                } else if (this.toolMode === 'pan' && !this.isDrawingWall) {
                    this.pan.x += e.offsetX - lastMouse.x;
                    this.pan.y += e.offsetY - lastMouse.y;
                }
                lastMouse = {x: e.offsetX, y: e.offsetY};
            }
            
            if (this.isDrawingWall && this.isDM) {
                this.hoveredWall = {x1: this.wallStart.x, y1: this.wallStart.y, x2: world.x, y2: world.y};
            } else {
                this.hoveredWall = null;
            }
        });

        this.canvas.addEventListener('mouseup', (e) => {
            if (this.isDragging && this.dragToken) {
                this.notifyStateChange();
            }
            if (this.isDrawingWall && this.isDM && this.hoveredWall) {
                this.walls.push(this.hoveredWall);
                this.hoveredWall = null;
                this.notifyStateChange();
            }
            isMouseDown = false;
            this.isDragging = false;
            this.dragToken = null;
            this.isDrawingWall = false;
            this.wallStart = null;
        });
    }

    // --- Render Loop ---
    loop() {
        requestAnimationFrame(() => this.loop());
        
        // Resize canvas to match display size
        const rect = this.canvas.getBoundingClientRect();
        if (this.canvas.width !== rect.width || this.canvas.height !== rect.height) {
            this.canvas.width = rect.width;
            this.canvas.height = rect.height;
        }

        const ctx = this.ctx;
        ctx.fillStyle = '#111';
        ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

        ctx.save();
        ctx.translate(this.pan.x, this.pan.y);
        ctx.scale(this.zoom, this.zoom);

        // 1. Draw Map
        if (this.hasMap) {
            ctx.drawImage(this.mapImage, 0, 0);
        }

        // 2. Draw Walls (if DM)
        if (this.isDM) {
            ctx.strokeStyle = 'red';
            ctx.lineWidth = 2;
            this.walls.forEach(w => {
                ctx.beginPath();
                ctx.moveTo(w.x1, w.y1);
                ctx.lineTo(w.x2, w.y2);
                ctx.stroke();
            });
            if (this.hoveredWall) {
                ctx.strokeStyle = 'rgba(255, 0, 0, 0.5)';
                ctx.beginPath();
                ctx.moveTo(this.hoveredWall.x1, this.hoveredWall.y1);
                ctx.lineTo(this.hoveredWall.x2, this.hoveredWall.y2);
                ctx.stroke();
            }
        }

        // 3. Fog of War
        if (this.hasMap) {
            // Draw global darkness
            ctx.save();
            ctx.fillStyle = 'rgba(0, 0, 0, 0.85)';
            ctx.fillRect(0, 0, this.mapImage.width, this.mapImage.height);
            
            // Cut out vision for all ally tokens
            ctx.globalCompositeOperation = 'destination-out';
            ctx.fillStyle = 'black';
            
            this.tokens.filter(t => t.isAlly).forEach(t => {
                const poly = this.getSightPolygon(t.x, t.y);
                if (poly.length > 0) {
                    ctx.beginPath();
                    ctx.moveTo(poly[0].x, poly[0].y);
                    for(let i=1; i<poly.length; i++) ctx.lineTo(poly[i].x, poly[i].y);
                    ctx.fill();
                }
                
                // Add soft light radius
                const grad = ctx.createRadialGradient(t.x, t.y, 0, t.x, t.y, t.size * 4);
                grad.addColorStop(0, 'rgba(0,0,0,1)');
                grad.addColorStop(1, 'rgba(0,0,0,0)');
                ctx.fillStyle = grad;
                ctx.beginPath();
                ctx.arc(t.x, t.y, t.size * 4, 0, Math.PI*2);
                ctx.fill();
            });
            ctx.restore();
        }

        // 4. Draw Tokens
        this.tokens.forEach(t => {
            // Check visibility if not DM
            if (!this.isDM && !t.isAlly) {
                // If enemy is completely in Fog, hide it.
                // Simple heuristic: check if enemy center is inside ANY ally's sight polygon
                let isVisible = false;
                for(let ally of this.tokens.filter(a => a.isAlly)) {
                    // Check line of sight from ally to enemy
                    let hasWall = false;
                    const ray = {x: ally.x, y: ally.y, dx: t.x - ally.x, dy: t.y - ally.y};
                    const distSq = ray.dx*ray.dx + ray.dy*ray.dy;
                    this.walls.forEach(w => {
                        const intersect = this.getIntersection(ray, w);
                        if (intersect && intersect.param > 0 && intersect.param < 1) {
                            // Hit a wall before reaching enemy
                            hasWall = true;
                        }
                    });
                    if (!hasWall) { isVisible = true; break; }
                }
                if (!isVisible) return; // HIDDEN!
            }

            if (t.img && t.img.complete) {
                ctx.drawImage(t.img, t.x - t.size/2, t.y - t.size/2, t.size, t.size);
            } else {
                ctx.fillStyle = t.isAlly ? 'blue' : 'red';
                ctx.beginPath(); ctx.arc(t.x, t.y, t.size/2, 0, Math.PI*2); ctx.fill();
            }
            
            // Border
            ctx.strokeStyle = t.isAlly ? '#66fcf1' : '#ff4b4b';
            ctx.lineWidth = 3;
            ctx.beginPath(); ctx.arc(t.x, t.y, t.size/2, 0, Math.PI*2); ctx.stroke();
            
            if (t.isLocked && this.isDM) {
                ctx.fillStyle = 'rgba(255,0,0,0.8)';
                ctx.font = '14px Arial';
                ctx.fillText('🔒', t.x - 7, t.y - t.size/2 - 5);
            }
        });

        ctx.restore();
    }
}
window.VTTEngine = VTTEngine;
