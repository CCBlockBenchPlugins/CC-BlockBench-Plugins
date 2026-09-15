(function() {

	let styleElement;
	let crosshairEnabled = false;
	let gridOverlayEnabled = false;
	let overlayOpacity = 100;
	let overlayInvert = true;

	BBPlugin.register('crosshair_overlay', {
		title: '十字准星 & 九宫格',
		author: 'Custom',
		description: '在3D预览窗口中央显示十字准星和九宫格辅助线，支持透明度调节和反色模式',
		icon: 'gps_fixed',
		version: '1.2.0',
		variant: 'both',

		onload() {
			styleElement = document.createElement('style');
			document.head.appendChild(styleElement);
			rebuildCSS();

			ViewOptionsDialog.form_config.crosshair = {
				label: '十字准星',
				type: 'checkbox',
				style: 'toggle_switch',
				value: false
			};

			ViewOptionsDialog.form_config.grid_overlay = {
				label: '九宫格',
				type: 'checkbox',
				style: 'toggle_switch',
				value: false
			};

			ViewOptionsDialog.form_config.overlay_opacity = {
				label: '辅助线透明度',
				type: 'range',
				min: 5,
				max: 100,
				step: 5,
				value: 100
			};

			ViewOptionsDialog.form_config.overlay_invert = {
				label: '辅助线反色',
				type: 'checkbox',
				style: 'toggle_switch',
				value: true
			};

			let originalOnOpen = ViewOptionsDialog.onOpen;
			ViewOptionsDialog.onOpen = function() {
				originalOnOpen.call(this);
				this.form.setValues({
					crosshair: crosshairEnabled,
					grid_overlay: gridOverlayEnabled,
					overlay_opacity: overlayOpacity,
					overlay_invert: overlayInvert
				});
			};

			let originalOnFormChange = ViewOptionsDialog.onFormChange;
			ViewOptionsDialog.onFormChange = function(result) {
				originalOnFormChange.call(this, result);
				if (crosshairEnabled != result.crosshair) {
					crosshairEnabled = result.crosshair;
					document.querySelectorAll('.crosshair-overlay').forEach(el => {
						el.classList.toggle('visible', crosshairEnabled);
					});
				}
				if (gridOverlayEnabled != result.grid_overlay) {
					gridOverlayEnabled = result.grid_overlay;
					document.querySelectorAll('.grid-overlay').forEach(el => {
						el.classList.toggle('visible', gridOverlayEnabled);
					});
				}
				if (overlayOpacity != result.overlay_opacity) {
					overlayOpacity = result.overlay_opacity;
					rebuildCSS();
				}
				if (overlayInvert != result.overlay_invert) {
					overlayInvert = result.overlay_invert;
					rebuildCSS();
				}
			};

			Preview.all.forEach(preview => {
				addOverlaysToPreview(preview);
			});

			Blockbench.on('create_preview', onCreatePreview);
		},

		onunload() {
			delete ViewOptionsDialog.form_config.crosshair;
			delete ViewOptionsDialog.form_config.grid_overlay;
			delete ViewOptionsDialog.form_config.overlay_opacity;
			delete ViewOptionsDialog.form_config.overlay_invert;

			document.querySelectorAll('.crosshair-overlay').forEach(el => el.remove());
			document.querySelectorAll('.grid-overlay').forEach(el => el.remove());

			if (styleElement) styleElement.remove();

			Blockbench.removeListener('create_preview', onCreatePreview);
		}
	});

	function rebuildCSS() {
		if (!styleElement) return;
		let opacity = overlayOpacity / 100;
		let blend = overlayInvert ? 'difference' : 'normal';
		let color = overlayInvert ? 'white' : '#bbb';
		styleElement.textContent = `
			.crosshair-overlay {
				position: absolute;
				top: 50%;
				left: 50%;
				transform: translate(-50%, -50%);
				pointer-events: none;
				display: none;
				opacity: ${opacity};
				mix-blend-mode: ${blend};
			}
			.crosshair-overlay.visible {
				display: block;
			}
			.crosshair-overlay::before,
			.crosshair-overlay::after {
				content: '';
				position: absolute;
				background: ${color};
			}
			.crosshair-overlay::before {
				width: 2px;
				height: 20px;
				top: -10px;
				left: -1px;
			}
			.crosshair-overlay::after {
				width: 20px;
				height: 2px;
				top: -1px;
				left: -10px;
			}
			.grid-overlay {
				position: absolute;
				top: 0;
				left: 0;
				width: 100%;
				height: 100%;
				pointer-events: none;
				display: none;
				mix-blend-mode: difference;
			}
			.grid-overlay.visible {
				display: block;
			}
			.grid-overlay .grid-line {
				position: absolute;
				background: white;
				opacity: 0.5;
			}
			.grid-overlay .grid-line-v {
				width: 1px;
				height: 100%;
				top: 0;
			}
			.grid-overlay .grid-line-h {
				height: 1px;
				width: 100%;
				left: 0;
			}
			.grid-overlay .grid-line-v1 { left: 33.33%; }
			.grid-overlay .grid-line-v2 { left: 66.66%; }
			.grid-overlay .grid-line-h1 { top: 33.33%; }
			.grid-overlay .grid-line-h2 { top: 66.66%; }
		`;
	}

	function onCreatePreview(data) {
		addOverlaysToPreview(data.preview);
	}

	function addOverlaysToPreview(preview) {
		if (!preview || !preview.canvas) return;
		let container = preview.canvas.parentElement;
		if (!container) return;

		if (!container.querySelector('.crosshair-overlay')) {
			let crosshair = document.createElement('div');
			crosshair.className = 'crosshair-overlay';
			if (crosshairEnabled) crosshair.classList.add('visible');
			container.appendChild(crosshair);
		}

		if (!container.querySelector('.grid-overlay')) {
			let grid = document.createElement('div');
			grid.className = 'grid-overlay';
			grid.innerHTML =
				'<div class="grid-line grid-line-v grid-line-v1"></div>' +
				'<div class="grid-line grid-line-v grid-line-v2"></div>' +
				'<div class="grid-line grid-line-h grid-line-h1"></div>' +
				'<div class="grid-line grid-line-h grid-line-h2"></div>';
			if (gridOverlayEnabled) grid.classList.add('visible');
			container.appendChild(grid);
		}

		rebuildCSS();
	}

})();
