/**
 * 旋转 Tab 重设手柄自身 (Rotate Tab Gizmo Align)
 *
 * 解决问题：多选旋转角度各不相同的模型时，Blockbench 的旋转手柄只能显示全局朝向，
 * 因为原生「局部空间」要求所有选中元素旋转一致，否则回退为全局。
 *
 * 用法：旋转工具下按住 Tab 点击某个【已选中】的模型块，
 *       旋转手柄即按该模型自身朝向显示，拖拽旋转也严格绕手柄显示的轴进行；
 *       Tab 点击空白恢复默认；参考块被移出选择（点击其他模型）时自动恢复默认。
 *
 * 开关：菜单栏「工具 → 旋转 Tab 重设手柄自身」，状态自动保存。
 */
(function() {
    const PLUGIN_ID = 'rotate_tab_gizmo';

    let tab_pressed = false;     // Tab 按住状态
    let ref_element = null;      // 手柄朝向参考元素（Tab+点击的模型）
    let toggle = null;           // 工具菜单开关
    let patches = [];            // 方法补丁恢复函数
    let cleanups = [];           // 事件/监听清理函数

    function safe(fn, fallback) {
        try { return fn(); } catch (e) { return fallback; }
    }

    function isEnabled() {
        return !!(toggle && toggle.value);
    }

    // 旋转工具激活（编辑/姿态模式 + rotate_tool）
    function isRotateToolActive() {
        return typeof Modes !== 'undefined' && (Modes.id === 'edit' || Modes.id === 'pose')
            && typeof Toolbox !== 'undefined' && Toolbox.selected && Toolbox.selected.id === 'rotate_tool';
    }

    // 参考元素被删除或不再被选中（用户点了其他模型）时失效，手柄恢复默认
    function isOverrideValid() {
        let el = ref_element;
        if (!el || !el.mesh || !el.selected) return false;
        if (typeof Cube !== 'undefined' && el instanceof Cube) return Cube.all.includes(el);
        if (typeof Mesh !== 'undefined' && el instanceof Mesh) return Mesh.all.includes(el);
        return true; // 其他元素类型（如组）不主动失效
    }

    function patchMethod(object, key, wrapper) {
        if (!object || typeof object[key] !== 'function') return false;
        let original = object[key];
        object[key] = wrapper(original);
        patches.push(() => { object[key] = original; });
        return true;
    }

    // ============ 手柄朝向补丁 ============
    // 手柄朝向由 Transformer.rotation_ref 决定，但 Transformer.center()（选择/工具刷新时调用）
    // 开头会 delete rotation_ref 再按空间设置重算——多选旋转不一致时空间回退为全局。
    // 补丁在原生 center 之后重新套用参考元素，并在失效时清空引用。
    function installCenterPatch() {
        if (typeof Transformer === 'undefined' || typeof Transformer.center !== 'function') return false;
        return patchMethod(Transformer, 'center', original => function() {
            let result = original.apply(this, arguments);
            if (ref_element && isEnabled() && isRotateToolActive()) {
                safe(() => {
                    if (!isOverrideValid()) { ref_element = null; return; }
                    Transformer.rotation_ref = ref_element.mesh;
                    Transformer.update();
                });
            }
            return result;
        });
    }

    // ============ 旋转应用补丁 ============
    // override 激活时手柄按参考元素朝向显示，拖拽角度也在参考系内测得，
    // 但原生 onMove 走 getEditTransformSpace()——多选旋转不一致时回退全局空间，绕世界轴旋转（与显示不符）。
    // 这里把环轴（x/y/z）转换为参考元素局部轴的世界方向，以 Vector3 轴调用 rotateOnAxis
    // （与原生 E 环视角旋转同一机制），使实际旋转与手柄显示完全一致。
    function installMovePatch() {
        if (typeof TransformerModule === 'undefined' || !TransformerModule.modules
            || !TransformerModule.modules.edit || typeof rotateOnAxis !== 'function') return false;
        return patchMethod(TransformerModule.modules.edit, 'onMove', original => function(context) {
            if (ref_element && isEnabled() && isRotateToolActive()
                && Toolbox.selected.transformerMode === 'rotate'
                && typeof context.axis_number !== 'undefined' && context.axis_number !== null
                && isOverrideValid()) {
                let axis_vec = safe(() => {
                    let normal = context.axis_number === 0 ? new THREE.Vector3(1, 0, 0)
                        : context.axis_number === 1 ? new THREE.Vector3(0, 1, 0)
                        : new THREE.Vector3(0, 0, 1);
                    let q = ref_element.mesh.getWorldQuaternion(new THREE.Quaternion());
                    return normal.applyQuaternion(q);
                }, null);
                if (axis_vec) {
                    let difference = context.value - (this.previous_value || 0);
                    rotateOnAxis(n => (n + difference), axis_vec);
                    Canvas.updatePositions(true);
                    Transformer.updateSelection();
                    safe(() => Blockbench.setCursorTooltip(trimFloatNumber(context.value - this.initial_value)));
                    return;
                }
            }
            return original.apply(this, arguments);
        });
    }

    // ============ 事件处理 ============
    function onKeyDown(event) {
        if (event.key !== 'Tab' || !isEnabled() || !isRotateToolActive()) return;
        if (event.target && /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName || '')) return;
        tab_pressed = true;
        event.preventDefault(); // 防止焦点跳转
    }

    function onKeyUp(event) {
        if (event.key === 'Tab') tab_pressed = false;
    }

    function onWindowBlur() {
        tab_pressed = false;
    }

    // 旋转工具下 Tab + 左键点击模型：手柄按该模型自身朝向显示；Tab + 点击空白恢复默认。
    // 整次点击被吞掉，不改变当前多选。
    function onPointerDown(event) {
        if (event.button !== 0) return;
        if (!tab_pressed || !isEnabled() || !isRotateToolActive()) return;
        event.preventDefault();
        event.stopPropagation();
        if (event.stopImmediatePropagation) event.stopImmediatePropagation();
        let hit = safe(() => Canvas.raycast(event), null);
        if (hit && hit.element && hit.element.mesh) {
            if (!hit.element.selected) {
                // 手柄/旋转都作用于当前选择，对齐未选中的模型没有意义
                Blockbench.showQuickMessage('该模型未被选中，手柄未更改', 1500);
                return;
            }
            ref_element = hit.element;
            Blockbench.showQuickMessage('旋转手柄对齐：' + (hit.element.name || '元素'), 1500);
        } else {
            ref_element = null;
            Blockbench.showQuickMessage('旋转手柄恢复默认', 1200);
        }
        // center() 内部按空间设置重算手柄；center 补丁会在其后重新套用参考元素
        safe(() => { if (typeof Transformer !== 'undefined' && Transformer.center) Transformer.center(); });
    }

    function onToolSelect() {
        if (!isRotateToolActive()) {
            ref_element = null;
            tab_pressed = false;
        }
    }

    function addListeners() {
        let preview = document.getElementById('preview');
        if (!preview) return false;
        preview.addEventListener('pointerdown', onPointerDown, true);
        window.addEventListener('keydown', onKeyDown, true);
        window.addEventListener('keyup', onKeyUp, true);
        window.addEventListener('blur', onWindowBlur, true);
        cleanups.push(() => preview.removeEventListener('pointerdown', onPointerDown, true));
        cleanups.push(() => window.removeEventListener('keydown', onKeyDown, true));
        cleanups.push(() => window.removeEventListener('keyup', onKeyUp, true));
        cleanups.push(() => window.removeEventListener('blur', onWindowBlur, true));

        // 切换工具时清空参考元素
        safe(() => {
            if (typeof Tool !== 'undefined' && Array.isArray(Tool.all)) {
                Tool.all.forEach(tool => {
                    if (tool && typeof tool.on === 'function') {
                        let d = tool.on('select', onToolSelect);
                        cleanups.push(() => {
                            if (d && d.delete) d.delete();
                            else if (tool.removeListener) tool.removeListener('select', onToolSelect);
                        });
                    }
                });
            }
        });
        // 项目切换/关闭时清空
        ['new_project', 'load_project', 'close_project'].forEach(evt => {
            safe(() => {
                let d = Blockbench.on(evt, () => { ref_element = null; });
                cleanups.push(() => { if (d && d.delete) d.delete(); });
            });
        });
        return true;
    }

    Plugin.register(PLUGIN_ID, {
        title: '旋转 Tab 重设手柄自身',
        author: '编辑plus',
        description: '旋转工具下按住 Tab 点击选中的模型块，旋转手柄按该模型自身朝向显示并旋转；多选角度各异的模型时不再受全局手柄限制。Tab 点击空白恢复默认。',
        icon: '3d_rotation',
        version: '1.0.0',
        variant: 'both',
        onload() {
            toggle = new Toggle(PLUGIN_ID + '_enabled', {
                name: '旋转 Tab 重设手柄自身',
                description: '开启后：旋转工具下按住 Tab 点击选中的模型块，旋转手柄按该模型自身朝向显示',
                icon: '3d_rotation',
                default: true,
                save_on_restart: true,
                onChange(value) {
                    if (!value) {
                        ref_element = null;
                        tab_pressed = false;
                        safe(() => { if (typeof Transformer !== 'undefined' && Transformer.center) Transformer.center(); });
                    }
                }
            });
            MenuBar.addAction(toggle, 'tools');

            let ok = addListeners();
            ok = installCenterPatch() && ok;
            ok = installMovePatch() && ok;
            if (!ok) {
                console.warn('[旋转Tab手柄] 初始化不完整，部分功能可能不可用');
            }
        },
        onunload() {
            ref_element = null;
            tab_pressed = false;
            cleanups.forEach(fn => safe(fn));
            cleanups = [];
            patches.forEach(fn => safe(fn));
            patches = [];
            if (toggle) {
                safe(() => toggle.delete());
                toggle = null;
            }
        }
    });
})();
