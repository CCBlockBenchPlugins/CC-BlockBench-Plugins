/**
 * 平板双击撤回 / Tablet Double-Tap Undo
 * ---------------------------------------------------------------------------
 * 给平板等触屏设备加一个手势：在屏幕上「双击」（两次轻点）＝ 撤回上一步。
 *
 * 设计要点（来自 Blockbench 源码分析）：
 *  - 视图里的点选是在 canvas 的 pointerdown 上完成的（js/preview/preview.js），
 *    所以按住/拖动不会误判成双击；取消多指手势也不会触发。
 *  - 撤销入口沿用官方动作 Project.undo（js/undo.js 里的 Action 'undo'），
 *    因此多人协作（Edit Session）、撤销上限、选择记录都能正常工作。
 *  - 如果用户开启了「撤销选择记录」(settings.undo_selections)，双击时自己
 *    产生的选择记录会先回退，再撤回真正的编辑，避免「双击只回退了选择」。
 *  - Blockbench 默认开启「双击切换移动/旋转/缩放工具」，触屏双击会派生出
 *    dblclick。本插件在识别到双击后短时间拦截 dblclick，避免顺手切换工具。
 *
 * 安装：File > Plugins > Load Plugin from File（或把本文件拖进 Blockbench 窗口）
 * 依赖：Blockbench 4.9 及更高版本（在 5.1.6 源码上开发）
 */

(function() {

const PLUGIN_ID = 'tablet_double_tap_undo';

/* --------------------------------------------------------------------------
 * 常量
 * -------------------------------------------------------------------------- */

/** 设置项 id（统一加插件前缀，避免和 Blockbench 自带设置重名） */
const S = {
	enabled: PLUGIN_ID + '_enabled',
	interval: PLUGIN_ID + '_interval',
	tolerance: PLUGIN_ID + '_tolerance',
	zone: PLUGIN_ID + '_zone',
	ignore_paint: PLUGIN_ID + '_ignore_paint',
	restore_selection: PLUGIN_ID + '_restore_selection',
	vibrate: PLUGIN_ID + '_vibrate',
	message: PLUGIN_ID + '_message',
};

/** 单次轻点允许的最长时间，超过就算长按/拖拽，不参与双击判定 */
const MAX_TAP_DURATION = 450;
/** 按下期间移动超过这个距离就算拖拽（比双击容差更严格，用于尽早排除旋转视角） */
const DRAG_THRESHOLD = 12;

/** 被识别为「屏幕」的区域 */
const SURFACE_VIEWPORT = '#preview';
/**
 * 纹理 / UV 画布。它们在侧边面板里，需要单独放行；
 * 这里刻意不写通用的 canvas 选择器，避免把图层缩略图之类的画布也算进来。
 */
const SURFACE_TEXTURE = '#uv_viewport, #uv_frame, #texture_canvas_wrapper';

/** 落在这些元素上的轻点直接忽略：工具栏、面板、弹窗、输入控件等 */
const UI_SELECTOR = [
	'#main_toolbar', '#status_bar', '#panel_selector_bar', '#left_bar', '#right_bar',
	'#mobile_panel_overlay', '#toast_notification_list',
	'.panel', '.toolbar', '.toolbar_wrapper', '.tool', '.dialog', 'dialog',
	'.menu', '.window', '.sidebar', '.sp-container', '.color_picker',
	'input', 'textarea', 'select', 'button', 'label', '[contenteditable="true"]',
].join(',');

/* --------------------------------------------------------------------------
 * 状态
 * -------------------------------------------------------------------------- */

/** 当前按下的触点 id -> 按下时间（用于排除多指手势，并防止事件丢失后卡死） */
const active_pointers = new Map();
/** 触点记录超过这个时间没有抬起就当作残留清理掉 */
const POINTER_TIMEOUT = 5000;

const gesture = {
	/** 正在跟踪的轻点 */
	active: false,
	pointer_id: null,
	start_x: 0,
	start_y: 0,
	start_time: 0,
	moved: false,
	/** 这一下是不是双击的第二下 */
	follow_up: false,
	/** 这一下开始时的撤销位置 / 选择状态 */
	undo_index: 0,
	selection_save: null,

	/** 上一次完成的轻点 */
	last_tap_time: 0,
	last_tap_x: 0,
	last_tap_y: 0,
	last_tap_undo_index: 0,
	last_tap_selection_save: null,

	/** 双击处理完之后，用来吃掉浏览器补发的 mouse / dblclick 事件 */
	suppress_events_until: 0,
};

/** 插件自己创建的设置项，卸载时用来清理 */
const own_settings = {};
const listeners = [];

/* --------------------------------------------------------------------------
 * 小工具
 * -------------------------------------------------------------------------- */

function log(...args) {
	console.log('[双击撤回]', ...args);
}

function listen(target, type, handler, options) {
	target.addEventListener(type, handler, options);
	listeners.push([target, type, handler, options]);
}

function clear_listeners() {
	while (listeners.length) {
		const [target, type, handler, options] = listeners.pop();
		target.removeEventListener(type, handler, options);
	}
}

function create_setting(id, options) {
	own_settings[id] = new Setting(id, options);
	return own_settings[id];
}

/** 读取设置值，设置不存在时返回默认值 */
function value_of(id, fallback) {
	const setting = own_settings[id];
	if (!setting) return fallback;
	const value = setting.value;
	return value === undefined || value === null ? fallback : value;
}

function number_of(id, fallback, min, max) {
	let value = Number(value_of(id, fallback));
	if (!isFinite(value)) value = fallback;
	return Math.min(Math.max(value, min), max);
}

function is_touch_pointer(event) {
	if (event.pointerType === 'touch' || event.pointerType === 'pen') return true;
	// 个别浏览器（老版本 WebKit）不给 pointerType，此时靠设备判断
	return event.pointerType === undefined && !!Blockbench.isTouch;
}

function distance(x1, y1, x2, y2) {
	return Math.sqrt(Math.pow(x1 - x2, 2) + Math.pow(y1 - y2, 2));
}

/* --------------------------------------------------------------------------
 * 双击区域判定
 * -------------------------------------------------------------------------- */

function is_ui_target(target) {
	if (!(target instanceof Element)) return true;
	return !!target.closest(UI_SELECTOR);
}

/** 纹理绘制时（画笔类工具），双击很容易和落笔混淆，可选地整体关闭 */
function is_paint_tool_active() {
	if (typeof Modes != 'undefined' && Modes && Modes.paint) return true;
	if (typeof Toolbox != 'undefined' && Toolbox && Toolbox.selected && Toolbox.selected.paintTool) return true;
	return false;
}

function is_valid_surface(target) {
	if (!(target instanceof Element)) return false;
	// 只能在编辑器内部触发，标题栏、开始界面都不算
	if (!target.closest('#work_screen')) return false;
	if (value_of(S.ignore_paint, false) && is_paint_tool_active()) return false;

	const zone = value_of(S.zone, 'canvas');
	const in_viewport = !!target.closest(SURFACE_VIEWPORT);

	if (zone == 'viewport') return in_viewport && !is_ui_target(target);

	// 纹理/UV 画布本身就在面板里，优先判定为画布
	if (target.closest(SURFACE_TEXTURE)) return true;

	if (zone == 'canvas') return in_viewport && !is_ui_target(target);

	// 整个编辑界面：只要不落在控件上就算
	return !is_ui_target(target);
}

/* --------------------------------------------------------------------------
 * 撤销
 * -------------------------------------------------------------------------- */

function get_undo_system() {
	if (typeof Project == 'undefined' || !Project) return null;
	return Project.undo || null;
}

function get_undo_index() {
	const undo = get_undo_system();
	return undo ? undo.index : 0;
}

/**
 * 记录当前选择状态。用官方 UndoSystem.selectionSave 快照，
 * 这样双击后可以把「顺手点出来的选择」还原回去。
 */
function capture_selection() {
	if (!value_of(S.restore_selection, true)) return null;
	if (typeof Project == 'undefined' || !Project) return null;
	// Blockbench 自己开了「撤销选择记录」时，回退选择记录就等价于还原选择，不必再快照
	try {
		if (typeof settings != 'undefined' && settings.undo_selections && settings.undo_selections.value == true) return null;
	} catch (err) { /* 忽略 */ }
	if (typeof UndoSystem == 'undefined' || !UndoSystem.selectionSave) return null;
	try {
		return new UndoSystem.selectionSave(0);
	} catch (err) {
		console.warn('[双击撤回] 无法记录选择状态：', err);
		return null;
	}
}

function restore_selection(save) {
	if (!save) return;
	try {
		save.load();
	} catch (err) {
		console.warn('[双击撤回] 无法还原选择状态：', err);
	}
}

function show_feedback(text, is_error) {
	if (value_of(S.message, true) && typeof Blockbench != 'undefined' && Blockbench.showQuickMessage) {
		Blockbench.showQuickMessage(text, is_error ? 1500 : 1000);
	} else {
		log(text);
	}
	if (value_of(S.vibrate, true) && typeof navigator != 'undefined' && typeof navigator.vibrate == 'function') {
		try {
			navigator.vibrate(is_error ? [20, 60, 20] : 15);
		} catch (err) { /* 部分浏览器不支持，忽略 */ }
	}
}

/**
 * 执行撤回。
 * @param {number} undo_index 双击第一下开始前的撤销位置
 * @param {*} selection_save 双击第一下开始前的选择快照
 */
function perform_undo(undo_index, selection_save) {
	const undo = get_undo_system();
	if (!undo) {
		show_feedback('请先打开一个项目', true);
		return false;
	}

	const before = (typeof undo_index === 'number') ? undo_index : undo.index;

	// 双击过程中自己产生的「选择」记录先回退掉，避免双击只是回退了选择
	let guard = 0;
	while (undo.index > before && undo.index >= 1 && guard++ < 8) {
		const entry = undo.history[undo.index - 1];
		if (!entry || entry.type !== 'selection') break;
		undo.undo();
	}

	if (undo.index < 1) {
		restore_selection(selection_save);
		show_feedback('没有可以撤回的操作', true);
		return false;
	}

	const entry = undo.history[undo.index - 1];
	undo.undo();
	restore_selection(selection_save);

	const label = entry && entry.action ? tl(entry.action) : '';
	show_feedback(label ? ('已撤回：' + label) : '已撤回上一步操作');
	return true;
}

/* --------------------------------------------------------------------------
 * 手势识别
 * -------------------------------------------------------------------------- */

function reset_tap_chain() {
	gesture.last_tap_time = 0;
	gesture.last_tap_selection_save = null;
}

function cancel_current_touch() {
	gesture.active = false;
	gesture.selection_save = null;
}

function begin_touch(pointer_id, x, y, target) {
	cancel_current_touch();
	if (!is_valid_surface(target)) return;

	const now = performance.now();
	const interval = number_of(S.interval, 320, 100, 1000);
	const tolerance = number_of(S.tolerance, 32, 8, 200);

	gesture.active = true;
	gesture.pointer_id = pointer_id;
	gesture.start_x = x;
	gesture.start_y = y;
	gesture.start_time = now;
	gesture.moved = false;

	const is_follow_up = gesture.last_tap_time > 0 &&
		(now - gesture.last_tap_time) <= interval &&
		distance(x, y, gesture.last_tap_x, gesture.last_tap_y) <= tolerance;

	if (is_follow_up) {
		// 第二下：沿用第一下开始前的撤销位置和选择快照
		gesture.follow_up = true;
		gesture.undo_index = gesture.last_tap_undo_index;
		gesture.selection_save = gesture.last_tap_selection_save;
	} else {
		gesture.follow_up = false;
		gesture.undo_index = get_undo_index();
		gesture.selection_save = capture_selection();
	}
}

function move_touch(x, y) {
	if (!gesture.active || gesture.moved) return;
	if (distance(x, y, gesture.start_x, gesture.start_y) > DRAG_THRESHOLD) {
		gesture.moved = true;
	}
}

function end_touch(x, y) {
	if (!gesture.active) return;

	const start_x = gesture.start_x;
	const start_y = gesture.start_y;
	const start_time = gesture.start_time;
	const moved = gesture.moved;
	const is_follow_up = gesture.follow_up;
	const undo_index = gesture.undo_index;
	const selection_save = gesture.selection_save;
	cancel_current_touch();
	gesture.pointer_id = null;

	if (!value_of(S.enabled, true)) return;

	const now = performance.now();
	const duration = now - start_time;
	const tolerance = number_of(S.tolerance, 32, 8, 200);
	const interval = number_of(S.interval, 320, 100, 1000);

	// 拖动、长按都不是轻点：这一轮手势作废，重新开始计数
	if (moved || distance(x, y, start_x, start_y) > tolerance || duration > MAX_TAP_DURATION) {
		reset_tap_chain();
		return;
	}

	if (is_follow_up && (now - gesture.last_tap_time) <= interval + MAX_TAP_DURATION) {
		// 双击成立
		reset_tap_chain();
		gesture.suppress_events_until = now + 800;
		perform_undo(undo_index, selection_save);
		return;
	}

	// 记作一次普通轻点，等下一看看有没有第二下
	gesture.last_tap_time = now;
	gesture.last_tap_x = start_x;
	gesture.last_tap_y = start_y;
	gesture.last_tap_undo_index = undo_index;
	gesture.last_tap_selection_save = selection_save;
}

/* --------------------------------------------------------------------------
 * 事件
 * -------------------------------------------------------------------------- */

function on_pointerdown(event) {
	if (!value_of(S.enabled, true)) return;
	if (!is_touch_pointer(event)) return;
	// 触屏/笔的主键都是 0；笔杆按键等额外按键不参与手势
	if (typeof event.button == 'number' && event.button > 0) return;

	const now = performance.now();
	for (const [id, time] of active_pointers) {
		if (now - time > POINTER_TIMEOUT) active_pointers.delete(id);
	}
	active_pointers.set(event.pointerId, now);
	if (active_pointers.size > 1) {
		// 多指按下（缩放/旋转视角），本轮全部忽略
		cancel_current_touch();
		reset_tap_chain();
		return;
	}
	begin_touch(event.pointerId, event.clientX, event.clientY, event.target);
}

function on_pointermove(event) {
	if (!gesture.active || event.pointerId !== gesture.pointer_id) return;
	move_touch(event.clientX, event.clientY);
}

function on_pointerup(event) {
	active_pointers.delete(event.pointerId);
	if (!gesture.active || event.pointerId !== gesture.pointer_id) return;
	end_touch(event.clientX, event.clientY);
}

function on_pointercancel(event) {
	active_pointers.delete(event.pointerId);
	if (event.pointerId !== gesture.pointer_id) return;
	cancel_current_touch();
	reset_tap_chain();
}

/* 老浏览器没有 Pointer Events 时的退路 */
function find_touch(list, identifier) {
	for (let i = 0; i < list.length; i++) {
		if (list[i].identifier === identifier) return list[i];
	}
	return null;
}

function on_touchstart(event) {
	if (!value_of(S.enabled, true)) return;
	if (event.touches.length > 1) {
		cancel_current_touch();
		reset_tap_chain();
		return;
	}
	const touch = event.changedTouches[0];
	begin_touch(touch.identifier, touch.clientX, touch.clientY, event.target);
}

function on_touchmove(event) {
	if (!gesture.active) return;
	const touch = find_touch(event.touches, gesture.pointer_id);
	if (touch) move_touch(touch.clientX, touch.clientY);
}

function on_touchend(event) {
	// 双击已成立时，吃掉浏览器补发的 mouse / click / dblclick
	if (performance.now() <= gesture.suppress_events_until && event.cancelable) {
		event.preventDefault();
	}
	if (!gesture.active) return;
	const touch = find_touch(event.changedTouches, gesture.pointer_id);
	if (!touch) return;
	end_touch(touch.clientX, touch.clientY);
}

function on_touchcancel() {
	cancel_current_touch();
	reset_tap_chain();
}

/**
 * 触屏双击会被浏览器合成 dblclick，而 Blockbench 默认用双击切换
 * 移动/旋转/缩放工具（settings.double_click_switch_tools）。刚处理完
 * 双击撤回时把它拦下来，免得顺手把工具切了。
 */
function on_dblclick(event) {
	if (performance.now() > gesture.suppress_events_until) return;
	event.stopPropagation();
	if (event.cancelable) event.preventDefault();
}

/* --------------------------------------------------------------------------
 * 设置
 * -------------------------------------------------------------------------- */

const CATEGORY_NAME = '平板双击撤回';

/**
 * 建一个插件自己的设置分类。
 *
 * 这里没有直接用官方的 Settings.addCategory()：它内部会调用
 * DialogSidebar.build()，而设置窗口在用户第一次打开之前根本没有生成
 * （Dialog.build() 只在 show() 时才跑），那时 addCategory 会直接抛错。
 * 所以自己写一份：只要在设置窗口首次生成之前把分类塞进
 * Settings.structure / sidebar.pages，之后打开设置窗口就会自动带上这一页。
 */
function setup_settings_category() {
	const fallback = 'edit';
	try {
		if (typeof Settings == 'undefined' || !Settings.structure) return fallback;

		const category = {name: CATEGORY_NAME, open: true, items: {}};
		Settings.structure[PLUGIN_ID] = category;

		const sidebar = Settings.dialog && Settings.dialog.sidebar;
		if (sidebar && sidebar.pages) {
			sidebar.pages[PLUGIN_ID] = CATEGORY_NAME;
			if (Settings.dialog.object && sidebar.node && sidebar.node.parentElement) {
				// 设置窗口已经生成过了：重建侧边栏（先移除旧节点，免得出现两个侧边栏）
				sidebar.node.remove();
				sidebar.build();
			}
		}
		// 设置窗口的 Vue 实例已经存在时，新分类要经过 Vue.set 才会被渲染
		const vue = Settings.dialog && Settings.dialog.content_vue;
		if (vue && vue.$data && vue.$data.structure && typeof Vue != 'undefined' && Vue.set) {
			Vue.set(vue.$data.structure, PLUGIN_ID, category);
		}
		return PLUGIN_ID;
	} catch (err) {
		console.warn('[双击撤回] 创建独立设置分类失败，设置将出现在「编辑」分类下：', err);
		try { delete Settings.structure[PLUGIN_ID]; } catch (e) { /* 忽略 */ }
		return fallback;
	}
}

function create_settings() {
	const category = setup_settings_category();
	create_setting(S.enabled, {
		category,
		value: true,
		name: '启用双击撤回',
		description: '在触屏设备上，双击屏幕撤回上一步操作',
	});
	create_setting(S.interval, {
		category,
		type: 'number',
		value: 320,
		min: 100,
		max: 1000,
		step: 10,
		name: '双击判定间隔（毫秒）',
		description: '两次轻点之间的最大间隔，超过这个时间就不再算双击',
	});
	create_setting(S.tolerance, {
		category,
		type: 'number',
		value: 32,
		min: 8,
		max: 200,
		step: 4,
		name: '双击位置容差（像素）',
		description: '两次轻点允许的最大距离，手指移动幅度较大时可以调高',
	});
	create_setting(S.zone, {
		category,
		type: 'select',
		value: 'canvas',
		options: {
			viewport: '仅 3D 视口',
			canvas: '视口与画布（推荐）',
			screen: '整个编辑界面（避开控件）',
		},
		name: '双击生效区域',
		description: '决定在哪些区域双击才会触发撤回',
	});
	create_setting(S.ignore_paint, {
		category,
		value: false,
		name: '使用绘制工具时不响应双击',
		description: '画笔类工具下双击容易和落笔混淆，开启后绘制时不会触发撤回',
	});
	create_setting(S.restore_selection, {
		category,
		value: true,
		name: '撤回后还原双击前的选择',
		description: '双击的第一下可能会点中模型，开启后会把这个选择变化一并还原',
	});
	create_setting(S.vibrate, {
		category,
		value: true,
		name: '撤回时震动反馈',
		description: '设备支持震动时给出短促反馈',
	});
	create_setting(S.message, {
		category,
		value: true,
		name: '显示撤回提示',
		description: '在屏幕上方显示「已撤回：xxx」的提示',
	});
}

function delete_settings() {
	for (const id in own_settings) {
		try {
			if (typeof own_settings[id].delete == 'function') own_settings[id].delete();
		} catch (err) { /* 忽略 */ }
		delete own_settings[id];
	}
	try {
		if (typeof Settings != 'undefined' && Settings.structure) {
			const sidebar = Settings.dialog && Settings.dialog.sidebar;
			const vue = Settings.dialog && Settings.dialog.content_vue;
			// 如果设置窗口正停在这一页，先退回「常规」，免得它的分类被删掉后渲染报错
			if (vue && vue.$data && vue.$data.open_category === PLUGIN_ID) {
				vue.$data.open_category = 'general';
			}
			delete Settings.structure[PLUGIN_ID];
			if (sidebar && sidebar.pages) {
				delete Settings.dialog.sidebar.pages[PLUGIN_ID];
				if (Settings.dialog.object && sidebar.node && sidebar.node.parentElement) {
					sidebar.node.remove();
					sidebar.build();
				}
			}
			if (vue && vue.$data && vue.$data.structure) {
				if (typeof Vue != 'undefined' && Vue.delete) {
					Vue.delete(vue.$data.structure, PLUGIN_ID);
				} else {
					delete vue.$data.structure[PLUGIN_ID];
				}
			}
		}
	} catch (err) { /* 忽略 */ }
}

/* --------------------------------------------------------------------------
 * 事件绑定
 * -------------------------------------------------------------------------- */

function setup_events() {
	if (window.PointerEvent) {
		listen(window, 'pointerdown', on_pointerdown, {capture: true, passive: false});
		listen(window, 'pointermove', on_pointermove, {capture: true, passive: true});
		listen(window, 'pointerup', on_pointerup, {capture: true, passive: true});
		listen(window, 'pointercancel', on_pointercancel, {capture: true, passive: true});
		listen(window, 'touchend', on_touchend, {capture: true, passive: false});
	} else {
		listen(window, 'touchstart', on_touchstart, {capture: true, passive: true});
		listen(window, 'touchmove', on_touchmove, {capture: true, passive: true});
		listen(window, 'touchend', on_touchend, {capture: true, passive: false});
		listen(window, 'touchcancel', on_touchcancel, {capture: true, passive: true});
	}
	listen(window, 'dblclick', on_dblclick, {capture: true, passive: false});
}

/* --------------------------------------------------------------------------
 * 插件注册
 * -------------------------------------------------------------------------- */

Plugin.register(PLUGIN_ID, {
	title: '平板双击撤回',
	author: 'Anonymous',
	description: '为平板等触屏设备增加「双击屏幕 = 撤回上一步」的手势。',
	icon: 'undo',
	about: [
		'## 平板双击撤回',
		'',
		'在触屏设备上**双击屏幕**即可撤回上一步操作，省去调出键盘按 Ctrl+Z 的麻烦。',
		'',
		'### 用法',
		'',
		'- 在 3D 视口（或纹理/UV 画布）上快速点两下 = 撤回上一步',
		'- 两下点得越近、越快越容易触发；拖动视角、双指缩放不会误触发',
		'- 撤回时会显示「已撤回：xxx」提示，并在支持的设备上给出轻微震动',
		'',
		'### 设置',
		'',
		'在 `文件 > 偏好设置 > 设置 > 平板双击撤回` 中可以调整双击间隔、位置容差、生效区域，',
		'也可以关闭绘制工具下的响应、关闭提示或震动。',
	].join('\n'),
	version: '1.0.0',
	variant: 'both',
	min_version: '4.9.0',
	tags: ['mobile', 'touch', 'utility'],

	onload() {
		create_settings();
		setup_events();
		log('已启用，双击屏幕即可撤回上一步');
	},

	onunload() {
		clear_listeners();
		delete_settings();
		reset_tap_chain();
		active_pointers.clear();
	},

	oninstall() {
		Blockbench.showQuickMessage('平板双击撤回已安装：双击屏幕即可撤回', 3000);
	},
});

})();
