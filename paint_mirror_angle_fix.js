// 绘画镜像角度修复
// 修复 Blockbench 镜像绘画在「带旋转元素」模型上的落点错误（典型：多个同位平板旋转拼出的圆柱）。
//
// 原版问题：Painter.getMirrorPaintTargets 的方块分支只在 UV 平面做镜像换算，且 getMirrorElement
// 只按位置条件找镜像方块——同位旋转拼出的模型（圆柱各分段 from/to 完全相同）会永远选中列表里
// 第一个分段，导致镜像落点错误。
//
// 修复思路：
//  1. 镜像换算改为 3D 世界空间（对齐原版网格 Mesh 分支）：绘点 → 源面局部 3D → 世界镜像 →
//     目标方块局部 → 按法线匹配面 → 反算 UV，源/目标旋转经 mesh 矩阵自然纳入；
//  2. 镜像元素搜索：位置条件初筛后按「镜像旋转规则」评分（镜像面法向轴旋转不变、其余轴取反，
//     容忍平板 180° 旋转自对称），并校验镜像点确实落在目标面上，全部失败回退原版行为。
(function() {
    'use strict';

    function safe(fn) {
        try { return fn(); } catch (e) { console.error('[绘画镜像角度修复]', e); }
    }

    const PAINT_FACE_NORMALS = { east: [1,0,0], west: [-1,0,0], up: [0,1,0], down: [0,-1,0], south: [0,0,1], north: [0,0,-1] };

    // CubeFace.UVToLocal 的逆运算：面局部坐标（相对 origin）→ 面 UV 坐标
    function paintFaceLocalToUV(face, vec) {
        let cube = face.cube;
        // 内联 adjustFromAndToForInflateAndStretch（inflate/stretch 后的实际 from/to）
        let half = cube.size().map(v => v / 2);
        let from = [0, 1, 2].map(i => cube.from[i] + half[i] - (half[i] + cube.inflate) * cube.stretch[i]);
        let to   = [0, 1, 2].map(i => cube.from[i] + half[i] + (half[i] + cube.inflate) * cube.stretch[i]);
        let x = vec.x + cube.origin[0];
        let y = vec.y + cube.origin[1];
        let z = vec.z + cube.origin[2];
        let lerp_x, lerp_y;
        switch (face.direction) {
            case 'east':  lerp_x = Math.getLerp(to[2], from[2], z);  lerp_y = Math.getLerp(to[1], from[1], y); break;
            case 'west':  lerp_x = Math.getLerp(from[2], to[2], z);  lerp_y = Math.getLerp(to[1], from[1], y); break;
            case 'up':    lerp_x = Math.getLerp(from[0], to[0], x);  lerp_y = Math.getLerp(from[2], to[2], z); break;
            case 'down':  lerp_x = Math.getLerp(from[0], to[0], x);  lerp_y = Math.getLerp(to[2], from[2], z); break;
            case 'south': lerp_x = Math.getLerp(from[0], to[0], x);  lerp_y = Math.getLerp(to[1], from[1], y); break;
            case 'north': lerp_x = Math.getLerp(to[0], from[0], x);  lerp_y = Math.getLerp(to[1], from[1], y); break;
            default: return null;
        }
        // UVToLocal 中按 face.rotation 每 90° 做 [lx,ly]=[1-ly,lx]，这里逐步逆向还原
        for (let i = 0; i < (face.rotation || 0); i += 90) {
            [lerp_x, lerp_y] = [lerp_y, 1 - lerp_x];
        }
        return [
            Math.lerp(face.uv[0], face.uv[2], lerp_x),
            Math.lerp(face.uv[1], face.uv[3], lerp_y)
        ];
    }

    // 计算镜像绘点（仅方块；网格/2D/动画贴图走原版逻辑）。返回空数组表示无法处理，回退原版
    function paintAngleFixTargets(texture, x, y) {
        let src_el = Painter.current.element;
        let src_fkey = Painter.current.face;
        let src_face = src_el.faces[src_fkey];
        if (!src_face || !src_el.mesh) return [];
        let opts = Painter.mirror_painting_options;
        let center = Format.centered_grid ? 0 : 8;
        let f_u = texture.getUVWidth() / texture.width;    // px → UV 单位
        let f_v = texture.getUVHeight() / texture.height;
        let even_brush_size = BarItems.slider_brush_size.get()%2 == 0 && Toolbox.selected.brush?.offset_even_radius && Condition(Toolbox.selected.brush?.floor_coordinates);
        if (Toolbox.selected.id == 'gradient_tool') even_brush_size = true;
        let src_uv = [
            (even_brush_size ? x : x + 0.5) * f_u,
            (even_brush_size ? y : y + 0.5) * f_v
        ];
        // 镜像轴组合展开（与原版一致）
        let mirror_vectors = [[opts.axis.x?1:0, 0, opts.axis.z?1:0]];
        if (mirror_vectors[0].filter(v => v).length == 3) {
            mirror_vectors = [[1,0,0],[0,1,0],[0,0,1],[1,1,0],[0,1,1],[1,0,1],[1,1,1]];
        } else if (mirror_vectors[0].equals([1,1,0])) {
            mirror_vectors = [[1,0,0],[0,1,0],[1,1,0]];
        } else if (mirror_vectors[0].equals([0,1,1])) {
            mirror_vectors = [[0,1,0],[0,0,1],[0,1,1]];
        } else if (mirror_vectors[0].equals([1,0,1])) {
            mirror_vectors = [[1,0,0],[0,0,1],[1,0,1]];
        }
        function pickFaceKey(nl) {
            let best = null, best_dot = -Infinity;
            for (let key in PAINT_FACE_NORMALS) {
                let n = PAINT_FACE_NORMALS[key];
                let d = nl.x*n[0] + nl.y*n[1] + nl.z*n[2];
                if (d > best_dot) { best_dot = d; best = key; }
            }
            return best;
        }
        // 镜像候选方块：先满足原版位置条件（from/to 关于镜像面对称等），再按「镜像旋转规则」评分排序——
        // 镜像面法向轴的旋转保持不变、其余轴取反（单轴旋转的共轭规则），并容忍 180° 旋转自对称（平板拼圆柱等）。
        // 原版 getMirrorElement 只返回第一个位置匹配者，同位多次旋转拼出的模型（圆柱）会永远选错分段
        function mirrorCandidates(axes) {
            let sym = axes.map((v, i) => v ? i : false).filter(v => v !== false);
            let off = [0, 1, 2].filter(i => !sym.includes(i));
            let expected = [0, 1, 2].map(i => sym.includes(i) ? (src_el.rotation[i] || 0) : -(src_el.rotation[i] || 0));
            function angDiff(a, b) {
                let d = Math.abs(a - b) % 360;
                if (d > 180) d = 360 - d;
                return Math.min(d, Math.abs(180 - d));
            }
            let cands = [];
            for (let el2 of Cube.all) {
                if (!Math.epsilon(src_el.inflate, el2.inflate, 0.01)) continue;
                if (off.find(a => !Math.epsilon(src_el.from[a], el2.from[a], 0.01)) !== undefined) continue;
                if (off.find(a => !Math.epsilon(src_el.to[a], el2.to[a], 0.01)) !== undefined) continue;
                if (sym.find(a => !Math.epsilon(src_el.size(a), el2.size(a), 0.01)) !== undefined) continue;
                if (sym.find(a => !Math.epsilon(src_el.to[a]-center, center-el2.from[a], 0.01)) !== undefined) continue;
                let score = 0;
                for (let i = 0; i < 3; i++) score += angDiff(expected[i], el2.rotation[i] || 0);
                cands.push({ el: el2, score });
            }
            cands.sort((a, b) => a.score - b.score);
            return cands.map(c => c.el);
        }
        // 目标面所在平面的局部坐标（origin 相对，含 inflate/stretch 修正），用于校验镜像点确实落在面上
        function facePlane(cube, fkey) {
            let axis = (fkey === 'east' || fkey === 'west') ? 0 : (fkey === 'up' || fkey === 'down') ? 1 : 2;
            let pos = (fkey === 'east' || fkey === 'up' || fkey === 'south');
            let half = cube.size()[axis] / 2;
            let bound = cube.from[axis] + half + (pos ? 1 : -1) * (half + cube.inflate) * cube.stretch[axis];
            return { axis, value: bound - cube.origin[axis] };
        }
        let targets = [];
        mirror_vectors.forEach(axes => {
            [false, true, null].forEach(mode => {
                // false=全局镜像，true=本地（自身）镜像，null=两者同时（与原版推送规则一致）
                if (mode === false && !opts.global) return;
                if (mode === true && !opts.local) return;
                if (mode === null && !(opts.global && opts.local)) return;
                // 绘点：面 UV → 局部 3D（相对 origin）
                let lp = src_face.UVToLocal(src_uv);
                if (mode !== false) { // 本地 / 两者：先在局部空间按轴取反
                    if (axes[0]) lp.x *= -1;
                    if (axes[1]) lp.y *= -1;
                    if (axes[2]) lp.z *= -1;
                }
                let wp = src_el.mesh.localToWorld(lp);
                if (mode !== true) { // 全局 / 两者：再在世界空间按轴镜像
                    if (axes[0]) wp.x = 2*center - wp.x;
                    if (axes[1]) wp.y = 2*center - wp.y;
                    if (axes[2]) wp.z = 2*center - wp.z;
                }
                // 由候选元素构建镜像目标：法线换算选面 + 落点校验（validate=false 不校验，用于回退原版行为）
                let buildTarget = (mirror_element, validate) => {
                    if (!(mirror_element instanceof Cube) || !mirror_element.mesh) return null;
                    let tp = mirror_element.mesh.worldToLocal(wp.clone());
                    // 法线换算决定落到目标的哪个面（源/目标的旋转都经矩阵纳入）
                    let nl;
                    if (mode === true) {
                        nl = new THREE.Vector3(...PAINT_FACE_NORMALS[src_fkey]);
                        if (axes[0]) nl.x *= -1;
                        if (axes[1]) nl.y *= -1;
                        if (axes[2]) nl.z *= -1;
                    } else {
                        let nw = new THREE.Vector3(...PAINT_FACE_NORMALS[src_fkey]).transformDirection(src_el.mesh.matrixWorld);
                        if (mode === false) { // 全局镜像：世界空间按轴取反；两者同时：对齐原版网格分支不取反
                            if (axes[0]) nw.x *= -1;
                            if (axes[1]) nw.y *= -1;
                            if (axes[2]) nw.z *= -1;
                        }
                        nl = nw.transformDirection(new THREE.Matrix4().copy(mirror_element.mesh.matrixWorld).invert());
                    }
                    let tfkey = pickFaceKey(nl);
                    let tface = mirror_element.faces[tfkey];
                    if (!tface) return null;
                    let tuv = paintFaceLocalToUV(tface, tp);
                    if (!tuv || !isFinite(tuv[0]) || !isFinite(tuv[1])) return null;
                    if (validate) {
                        let pv = facePlane(mirror_element, tfkey);
                        if (Math.abs(tp.getComponent(pv.axis) - pv.value) > 0.06) return null; // 不在面平面上
                        let lx = Math.getLerp(tface.uv[0], tface.uv[2], tuv[0]);
                        let ly = Math.getLerp(tface.uv[1], tface.uv[3], tuv[1]);
                        if (lx < -0.02 || lx > 1.02 || ly < -0.02 || ly > 1.02) return null; // 不在面范围内
                    }
                    return {
                        element: mirror_element,
                        x: Math.roundTo(tuv[0] / f_u, 8),
                        y: Math.roundTo(tuv[1] / f_v, 8),
                        uv_tag: tface.uv,
                        face: tfkey
                    };
                };
                let target = null;
                if (mode === true) {
                    target = buildTarget(src_el, false);
                } else {
                    let cands = mirrorCandidates(axes);
                    for (let ci = 0; ci < cands.length && !target; ci++) target = buildTarget(cands[ci], true);
                    if (!target) { // 候选全部未通过校验 → 回退原版选元素逻辑（保持原版行为）
                        target = buildTarget(Painter.getMirrorElement(src_el, axes), false);
                    }
                }
                if (target) targets.push(target);
            });
        });
        return targets;
    }

    let original_get_targets = null;

    Plugin.register('paint_mirror_angle_fix', {
        title: '绘画镜像角度修复',
        author: '编辑plus',
        description: '修复镜像绘画在带旋转元素的模型（如平板拼圆柱）上的落点错误：镜像换算改为 3D 世界空间，并按镜像旋转规则选择正确的目标方块。',
        version: '1.0.0',
        variant: 'both',
        onload() {
            safe(() => {
                if (typeof Painter === 'undefined' || typeof Cube === 'undefined') return;
                if (typeof Painter.getMirrorPaintTargets !== 'function') return;
                original_get_targets = Painter.getMirrorPaintTargets;
                Painter.getMirrorPaintTargets = function(texture, x, y, uvTag) {
                    if (uvTag
                        && Painter.current.element instanceof Cube
                        && Painter.current.face
                        // 动画贴图的逐帧镜像组合较少见，交由原版处理
                        && !(Painter.mirror_painting_options.texture_frames && Format.animated_textures && texture && texture.frameCount > 1)) {
                        let fixed = safe(() => paintAngleFixTargets(texture, x, y));
                        if (fixed && fixed.length) return fixed;
                    }
                    return original_get_targets.call(this, texture, x, y, uvTag);
                };
            });
        },
        onunload() {
            if (original_get_targets && typeof Painter !== 'undefined') {
                Painter.getMirrorPaintTargets = original_get_targets;
                original_get_targets = null;
            }
        }
    });
})();
