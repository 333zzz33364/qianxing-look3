// Visual shell adapted from the supplied ClientUIAnimationEditor reference.
// The shared Studio transactions and host interfaces remain in look2.js.
export const REFERENCE_THEME = `
.look2{--bg:#303540;--panel:#303540;--panel2:#353d4b;--input:#262b35;--workspace:#454a53;--line:#454b58;--line2:#414855;--lineSoft:#414855;--text:#e4e7ef;--muted:#a9afbb;--blue:#527cf3;--hover:#3c4658;font-family:'Microsoft YaHei',sans-serif;color-scheme:dark;padding:0 6px 0;background:#e9e7ff;box-sizing:border-box}
.look2-icon{display:inline-block;flex:0 0 auto;vertical-align:middle}
.look2 button{display:inline-flex;align-items:center;justify-content:center;gap:7px;border-radius:5px}
.look2 button:focus-visible,.look2 summary:focus-visible{outline:2px solid #84bcff;outline-offset:2px}
.look2 input,.look2 select,.look2 textarea{background:var(--input)}
.look2-masthead{display:flex;align-items:center;gap:11px;flex:0 0 70px;min-width:0;padding:7px 0 10px;color:#40567a}
.look2-masthead .look2-menu-button{flex:0 0 54px;height:54px;border:0;background:#9685df;color:white;border-radius:8px}
.look2-brand{display:flex;align-items:center;gap:10px;flex:1;min-width:170px;height:54px;padding:0 20px;border-radius:11px;background:linear-gradient(105deg,#7159ce,#05bbea);color:#fff;white-space:nowrap;overflow:hidden}
.look2-brand strong{font-size:23px;letter-spacing:.3px;overflow:hidden;text-overflow:ellipsis}
.look2-brand small{align-self:flex-end;margin-bottom:8px;font-size:10px;opacity:.85}
.look2-brand-credit{flex:0 0 auto;margin-left:24px;font-size:14px;font-weight:500;color:#fff}
@media(max-width:1100px){.look2-brand-credit{margin-left:8px;font-size:12px}}
@media(max-width:520px){.look2-masthead .look2-brand{height:auto;min-height:44px;flex-wrap:wrap;gap:3px 8px;padding:6px 10px}.look2-brand-credit{flex-basis:100%;margin-left:0;padding-left:0;box-sizing:border-box;font-size:11px;white-space:normal}}
.look2-look-tools{display:flex;align-items:center;gap:9px;flex:0 0 auto}
.look2-look-tools .look2-asset-switch{margin:0;border:1px solid #d6d1f4;background:#f8f7ff;padding:4px;gap:4px}
.look2-look-tools .look2-asset-switch button{height:32px;font-size:11px;color:#40567a;padding:0 11px}
.look2-look-tools .look2-asset-switch button.active{background:#8270d2;color:white}
.look2-look-tools .play-group{display:flex;align-items:center;gap:6px;padding:6px 8px;border:1px solid #d6d1f4;border-radius:10px;background:#f8f7ff;color:#40567a}
.look2-look-tools select{background:#f8f7ff;color:#40567a;border-color:#d6d1f4;height:30px}
.look2-look-tools label{color:#6c7391}
.look2-look-tools .primary{height:32px;background:#527cf3;color:white;border-color:#527cf3}
.look2-look-tools .look2-play-stop{height:32px;background:#fff;border:1px solid #e0a6a6;color:#b23b3b}
.look2-look-tools .look2-play-stop:hover{background:#fdecec;border-color:#cf7f7f}
.look2-look-tools .look2-play-target-help{position:relative;display:inline-flex;flex:0 0 auto}
.look2-look-tools .look2-play-help-trigger{position:relative;z-index:43;height:28px;padding:0 7px;border:1px solid #d6d1f4;border-radius:6px;background:#f8f7ff;color:#40567a;font-size:11px;line-height:1}
.look2-look-tools .look2-play-help-trigger:hover,.look2-look-tools .look2-play-help-trigger[aria-expanded="true"]{background:#e7e3ff;border-color:#a99ee0;color:#2f3f5e}
.look2-play-help-backdrop{position:fixed;inset:0;z-index:41;background:transparent}
.look2-play-help-panel{position:absolute;left:50%;top:calc(100% + 7px);transform:translateX(-50%);z-index:42;display:flex;flex-direction:column;gap:5px;width:300px;padding:9px 11px;border:1px solid #c9c3ea;border-radius:8px;background:#fff;box-shadow:0 12px 30px #2b2a4a3d;color:#2f3f5e;font-weight:400;text-align:left;white-space:normal;line-height:1.5}
.look2-play-help-panel b{color:#5a44c0}
.look2-play-help-diff{color:#6c7391}
.look2-top{height:48px;min-height:48px;flex:0 0 48px;flex-wrap:nowrap;padding:0 12px;gap:6px;background:#2c313c;overflow:visible;z-index:8}
.look2-top .tool-group{border:0;gap:6px;padding:0;min-width:0;flex:0 0 auto}
.look2-top button{height:32px;border-color:transparent;background:transparent;white-space:nowrap;padding:0 9px;color:#d6deeb}
.look2-top button:hover{background:#384355;border-color:#536383}
.look2-top .primary{background:transparent;border-color:transparent}
.look2-project-copy{display:flex;flex-direction:column;width:178px;min-width:80px;gap:2px;padding:0 10px 0 0;margin-right:7px;border-right:1px solid var(--line);text-align:left}
.look2-project-copy strong{font-size:13px;margin:0;overflow:hidden;text-overflow:ellipsis}
.look2-project-copy small{font-size:10px;color:#92a8ce;overflow:hidden;text-overflow:ellipsis}
.look2-top .tool-select{max-width:100px;width:65px;height:32px;padding:0 6px;border:0;background:transparent;color:#c8d9fa;cursor:pointer}
.look2-top .canvas-select{width:174px;max-width:174px;border:1px solid var(--line);border-radius:6px;background:var(--input)}
.look2-archive-status{max-width:150px;color:#82c3ad;font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.look2-archive-status.error{color:#ffaaa5}
.look2-top .look2-lua-tools{width:84px;max-width:84px;height:32px;border:1px solid #596b8f;background:#3b465e;padding:0 9px;color:#c8d9fa}
.look2-lib-version{border:1px solid #596b8f;border-radius:3px;padding:3px 6px;color:#bdd1fa;font-size:10px;background:#354155}
.look2-zoom-control{display:flex;align-items:center;height:32px;border:1px solid var(--line);border-radius:7px;background:var(--input)}
.look2-zoom-control button{width:26px;padding:0}
.look2-zoom-control span{min-width:44px;text-align:center;color:#a9bfe8;font-size:11px}
.look2-pane{position:relative;background:var(--panel)}
.look2-pane-head{height:44px;min-height:44px;padding:8px 11px;color:#dce5f4}
.look2-pane-head button{width:26px;height:26px;padding:0;background:transparent;border-color:transparent;color:#c0cadb}
.look2-tree-toolbar{display:flex;align-items:center;gap:5px}
.look2-tree-tools{padding:10px 10px 8px;border:0}
.look2-tree-tools input{height:32px;border:1px solid var(--line);border-radius:18px;padding:0 13px;background:var(--input)}
.look2-tree-list{padding:6px 5px 12px}
.look2-tree-row{height:34px;margin-bottom:3px;gap:6px;border-radius:4px!important;background:#384252!important;color:#dce5f4}
.look2-tree-row.sel{background:#4c68ab!important;color:white}
.look2-tree-row .tree-name{justify-content:flex-start;height:30px;border:0;border-radius:0;background:transparent;font-weight:600;padding:0 2px}
.look2-tree-row .tree-name:hover{background:transparent}
.look2-tree-row .tree-action{color:#9aa8bc;width:21px;height:23px}
.look2-tree-row .tree-lock{opacity:0}
.look2-tree-row:hover .tree-lock,.look2-tree-row.locked-node .tree-lock,.look2-tree-row:focus-within .tree-lock{opacity:1}
.look2-tree-footer{display:flex;align-items:center;gap:6px;padding:9px;border-top:1px solid var(--line)}
.look2-add-menu{position:relative;flex:1;min-width:0}
.look2-add-menu summary{display:flex;align-items:center;justify-content:center;gap:7px;height:33px;border:1px solid #838c9c;border-radius:18px;color:#acc5ef;cursor:pointer;list-style:none}
.look2-add-menu summary::-webkit-details-marker{display:none}
.look2-add-menu .look2-add{position:absolute;bottom:41px;left:0;width:225px;max-width:calc(100vw - 28px);z-index:10;border:1px solid #536383;border-radius:8px;background:#353c49;box-shadow:0 10px 30px #0008;padding:6px}
.look2-add-menu .look2-add button{justify-content:flex-start;padding:7px;font-size:11px;border:0;background:transparent}
.look2-tree-delete{width:33px;height:33px;background:transparent;border-color:var(--line);color:#9aa8bc}
.look2-stage-heading{display:flex;align-items:center;gap:10px;height:36px;flex:0 0 36px;padding:0 14px;background:#353a45;border-bottom:1px solid var(--line);color:#c9d8f5;font-size:11px}
.look2-stage-heading button{padding:4px 9px;background:#343e4d;color:#adc4e8;border-color:#515c71;font-size:10px}
.look2-stage-hint{margin-left:auto;color:#9db5da;font-size:10px;white-space:nowrap}
.look2-stage-wrap{background-color:#454a53;background-image:radial-gradient(#b2bdcc28 .7px,transparent .7px);background-size:16px 16px}
.look2-stage{box-shadow:none;border-color:#79bbc6}
.look2-stage-tools{height:42px;min-height:42px;padding:5px 10px;gap:8px;background:#353a45;border-top:1px solid var(--line)}
.look2-stage-tools button{height:30px;border-color:transparent;background:transparent;color:#c7d4e8;padding:0 10px;white-space:nowrap}
.look2-stage-tools button.active{color:#8de5ef;border-color:#4f9eac;background:#37515c}
.look2-stage-status{position:absolute;bottom:8px;right:9px;padding:5px 9px;border-radius:5px;background:#353e4b;color:#c3d4ef;font-weight:600;font-size:10px;pointer-events:none}
.look2-stage-tools .look2-tool-hint{font-size:10px;color:#9ebae0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.look2-animations .look2-pane-head{height:54px;min-height:54px}
.look2-animator-title{display:flex;flex-direction:column;gap:4px}
.look2-animator-title small{color:#93aace;font-weight:400;font-size:10px}
.look2-animations .look2-anim-row{position:relative;padding:0;gap:0;margin-bottom:4px}
.look2-animations .look2-anim-row>button:first-child{display:flex;flex-direction:column;align-items:flex-start;justify-content:center;gap:3px;width:100%;min-height:50px;margin:0;padding:8px 35px 8px 32px;background:#343c4b;border:1px solid #4c576c}
.look2-anim-row>button:first-child:before{content:'◇';position:absolute;left:9px;top:10px;color:#edb1b4;font-size:23px}
.look2-animations .look2-anim-row>button.sel{background:#3d557c;border-color:#6b8ede}
.look2-anim-row>button:first-child small{font-size:10px;color:#a7bddc}
.look2-animations .look2-anim-row>.mini{position:absolute;right:4px;top:11px;height:25px;width:24px;margin:0;background:transparent;border:0}
.look2-animations>.look2-inspector{padding:11px 10px 14px;border-top:1px solid var(--line)}
.look2-animations .look2-field.wide input{height:29px;width:100%}
.look2-animations .look2-field button{height:27px;flex:1;font-size:10px;background:#363f4e}
.look2-inspector-pane>.look2-pane-head{height:65px;min-height:65px;padding:12px 15px}
.look2-inspector-title{display:flex;flex-direction:column;gap:5px;min-width:0}
.look2-inspector-title strong{font-size:18px;overflow:hidden;text-overflow:ellipsis}
.look2-inspector-title small{font-size:10px;font-weight:400;color:#9eb5d8}
.look2-inspector-tabs{display:flex;gap:3px;margin:5px 12px 10px;padding:3px;border:1px solid var(--line);border-radius:19px;background:var(--input)}
.look2-inspector-tabs button{flex:1;min-width:0;height:27px;padding:0;border:0;border-radius:16px;color:#b4c9ea}
.look2-inspector-tabs button.active{background:#527cf3;border:0;color:#fff}
.look2-inspector-tabs .look2-script-tab{flex:0 0 32px}
.look2-inspector{padding:0 12px 12px}
.look2-platform-picker{gap:6px;margin:4px 0 10px}
.look2-platform-picker button{height:36px;border:0;background:transparent;color:#bac6d7}
.look2-platform-picker button.selected{background:#527cf3;border-color:#527cf3}
.look2-platform-picker small{font-size:8px}
.look2 .qxsim-section{margin:5px 0 10px;border-radius:8px;background:#303744}
.look2 .qxsim-section summary{height:37px;padding:0 12px}
.look2 .qxsim-section-body{padding:11px 12px}
.look2 .qxsim-pair{grid-template-columns:0 minmax(0,1fr) minmax(0,1fr);gap:8px;margin-bottom:10px}
.look2 .qxsim-pair-name{overflow:hidden;white-space:nowrap}
.look2 .qxsim-field input[type=number],.look2 .qxsim-field input[type=text],.look2 .qxsim-field select{height:31px;width:100%;background:var(--input)}
.look2 .qxsim-field-label{color:#a7bfe6}
.look2 .qxsim-section-actions button{font-size:9px;padding:1px 3px}
.look2-dock{position:relative;min-height:150px;max-height:55%;background:#232b36;border-color:#596170}
.look2-dock:has(.look2-timeline)>.look2-dock-tabs{position:absolute;right:0;top:4px;width:auto;max-width:calc(100% - 12px);height:33px;z-index:6;border-bottom:0;background:#1d242e;overflow-x:auto;scrollbar-width:none}
.look2-dock:has(.look2-timeline)>.look2-dock-tabs>span:first-child{display:none}
.look2-dock:has(.look2-timeline) .look2-timeline-top{margin-right:var(--dock-tabs-space,205px)}
.look2-dock-content>.look2-timeline{flex:1 1 auto;min-width:0}
.look2-timeline-resize{position:relative;height:3px;flex-basis:3px;background:#596170}
.look2-timeline-resize:after{content:'';position:absolute;left:48%;top:-2px;width:54px;height:4px;border:1px solid #8c99ad;background:#454c59;border-radius:4px}
.look2-dock-tabs{justify-content:flex-end;height:28px;min-height:28px;background:#1d242e;padding:2px 8px}
.look2-dock-tabs>span:first-child{margin-right:auto;display:flex;align-items:center;gap:8px;padding-left:2px;color:#c7d8f7;font-size:10px}
.look2-dock-tabs button{min-width:48px;font-size:10px;border-radius:4px;padding:0 8px;border:0}
.look2-dock-tabs button.active{border:0;background:#3a4f70;color:#dce8fa}
.look2-timeline-top{height:36px;min-height:36px;background:#1d242e;padding:3px 10px;gap:7px;overflow-x:auto;scrollbar-width:thin;flex-wrap:nowrap}
.look2-timeline-top>*{flex:0 0 auto}
.look2-timeline-top button{border-color:transparent;background:transparent;color:#c6d3e5}
.look2-timeline-top button.selected{background:#375779;border-color:#527daa}
.look2-timeline-top input.timeline-seek{flex:0 1 110px;min-width:65px;accent-color:#e9bf61}
.look2-timeline-top input[type=number]{height:25px;width:56px}
.look2-time-readout{width:85px;font-size:10px}
.look2-timeline-top select{max-width:150px}
.look2-timeline-top .look2-sequence-name{color:#d7e4fc;font-size:10px;max-width:130px;overflow:hidden;text-overflow:ellipsis}
.look2-timeline-top .look2-timeline-hint{margin-left:auto;color:#8eacda;font-size:10px;white-space:nowrap;flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis}
@media (max-width:1100px){.look2-timeline-top .look2-timeline-hint{display:none}}
.look2-ruler-row{height:32px;min-height:32px}
.look2-ruler-row .look2-ruler-lane{height:32px}
.look2-ruler-mark{font-size:10px;padding:8px 4px;color:#adc7ee}
.look2-ruler-name,.look2-track-name{background:#27313f;color:#bed2f2;border-color:#454f61}
.look2-ruler-lane,.look2-track-lane{background-color:#232d39}
.look2-track,.look2-track-lane,.look2-track-name,.look2-track-group{min-height:31px;height:31px}
.look2-track-group .look2-ruler-lane{height:31px;background:#2e4057}
.look2-track-group .look2-ruler-name{background:#2e4057;font-weight:600;border-radius:0}
.look2-track-group[data-selected=true] .look2-ruler-name,.look2-track-group[data-selected=true] .look2-ruler-lane{background:#354c69}
.look2-event-row,.look2-event-lane{height:32px;min-height:32px;background-color:#302a40}
.look2-event-row .look2-ruler-name{background:#302a40;color:#c9aff0}
.look2-playhead{background:#ffda68;box-shadow:0 0 4px #ffda6840}
.look2-key-inspector{background:#252d39;padding:10px 12px}
.look2-key-inspector:has(.look2-key-empty){display:flex;flex-direction:column}
.look2-key-empty{display:flex;flex:1;flex-direction:column;align-items:center;justify-content:center;text-align:center;min-height:0;color:#91afd9;gap:10px;font-size:10px}
.look2-key-empty .diamond{font-size:40px;color:#718fac;line-height:1}
.look2-key-empty p{line-height:1.7;margin:0}
.look2-dock-footer{flex:0 0 19px;height:19px;padding:2px 10px;color:#a9c4eb;background:#1d242e;border-top:1px solid var(--line);font-size:9px}
.look2.playing .look2-look-tools .look2-asset-switch{pointer-events:none;opacity:.55}
@media(max-width:1400px){.look2-top{gap:3px;padding:0 7px}.look2-top button{padding:0 6px;gap:4px}.look2-project-copy{width:120px}.look2-top .tool-group{gap:3px}.look2-archive-status{max-width:100px}.look2-top .canvas-select{width:140px;max-width:140px}}
@media(max-width:1100px){.look2-brand strong{font-size:19px}.look2-brand small{display:none}.look2-masthead{gap:7px}.look2-look-tools{gap:5px}.look2-look-tools .look2-asset-switch button{padding:0 8px}.look2-top{height:auto;min-height:48px;flex-basis:auto;flex-wrap:wrap;padding:5px 8px}.look2-top .spacer{flex-basis:0}.look2-stage-hint{display:none}.look2-top .look2-archive-status{margin-left:auto}}
@media(max-width:820px){.look2-masthead{flex-wrap:wrap;flex-basis:auto;padding:6px 0;gap:6px}.look2-brand{height:44px}.look2-brand strong{font-size:18px}.look2-masthead .look2-menu-button{height:44px;flex-basis:42px}.look2-look-tools{width:100%;justify-content:space-between}.look2-look-tools .look2-asset-switch{flex:1;max-width:260px}.look2-top .look2-project-copy{width:110px}.look2-top .look2-lib-version{display:none}.look2-pane-head{height:34px;min-height:34px}.look2-inspector-pane>.look2-pane-head{height:48px;min-height:48px;padding:8px}.look2-inspector-title strong{font-size:14px}.look2-tree-row{height:30px}.look2-tree-list{padding:3px}.look2-tree-row .tree-lock{display:none}.look2-stage-tools{gap:3px;padding:3px 5px}.look2-stage-tools button{padding:0 5px;font-size:10px}.look2-tool-hint{display:none}.look2-inspector{padding:0 7px 7px}.look2-inspector-tabs{margin:3px 7px 7px}.look2-timeline-body{grid-template-columns:minmax(0,1fr) minmax(140px,28vw)}}
@media(max-width:520px){.look2-brand{min-width:0;padding:0 10px}.look2-brand strong{font-size:15px}.look2-look-tools{flex-wrap:wrap}.look2-look-tools .play-group{padding:3px 6px}.look2-look-tools .look2-asset-switch{max-width:none}.look2-top{max-height:none}.look2-top .look2-project-copy{width:86px}.look2-top .canvas-select{width:115px;max-width:115px}.look2-top button{font-size:10px}.look2-stage-heading{padding:0 6px;gap:5px}.look2-stage-heading button{font-size:9px;padding:3px 4px}.look2-tree-tools{padding:5px}.look2-tree-row .tree-action{width:12px}.look2-tree-footer{padding:5px}.look2-tree-delete{display:none}.look2-timeline-body{grid-template-columns:minmax(0,1fr)}}
`

// The reference's outline icon paths, rendered with the host's injected React.
const ICON_PATHS = {
  menu: ['M3 5h18M3 12h18M3 19h18'],
  folder: ['M3 8V5h6l2 3h10v12H3Z', 'M3 11h18'],
  plus: ['M12 5v14M5 12h14'],
  save: ['M4 3h13l3 3v15H4Z', 'M8 3v6h8V3M8 21v-8h8v8'],
  undo: ['M9 5 4 10l5 5', 'M4 10h10a6 6 0 0 1 0 12'],
  redo: ['m15 5 5 5-5 5', 'M20 10H10a6 6 0 0 0 0 12'],
  history: ['M3 12a9 9 0 1 0 3-6.7', 'M3 3v5h5', 'M12 7v5l3 2'],
  scene: ['m12 3 9 5-9 5-9-5Z', 'm3 12 9 5 9-5M3 16l9 5 9-5'],
  container: ['M7 3H3v4M17 3h4v4M21 17v4h-4M7 21H3v-4', 'M7 4h10M20 7v10M17 20H7M4 17V7'],
  image: ['M4 4h16v16H4Z', 'm4 16 5-5 4 4 3-3 4 4', 'M16 8a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z'],
  text: ['M4 4h16v16H4Z', 'M8 8h8M12 8v9M10 17h4'],
  eye: ['M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z', 'M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z'],
  'eye-off': ['M3 3l18 18', 'M9.5 5.3A12 12 0 0 1 12 5c6.5 0 10 7 10 7a18 18 0 0 1-3 4', 'M6.3 6.3A20 20 0 0 0 2 12s3.5 7 10 7a12 12 0 0 0 5.7-1.7'],
  lock: ['M7 10V7a5 5 0 0 1 10 0v3M5 10h14v11H5Z'],
  trash: ['M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7'],
  transform: ['M5 8V4h4M15 4h5v5M20 15v5h-5M9 20H4v-5', 'M8 12h8M12 8v8'],
  move: ['M12 3v18M3 12h18', 'm9 6 3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3m12-6 3 3-3 3'],
  rotate: ['M20 8a8 8 0 0 0-14-2L3 9', 'M3 3v6h6', 'M4 16a8 8 0 0 0 14 2l3-3', 'M15 15h6v6'],
  scale: ['M4 13v7h7v-7Z', 'm13 11 7-7M13 4h7v7'],
  fit: ['M8 3H3v5M16 3h5v5M21 16v5h-5M8 21H3v-5', 'M8 8h8v8H8Z'],
  sliders: ['M3 6h4m4 0h10M3 12h10m4 0h4M3 18h4m4 0h10', 'M11 6a2 2 0 1 1-4 0 2 2 0 0 1 4 0ZM17 12a2 2 0 1 1-4 0 2 2 0 0 1 4 0ZM11 18a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z'],
  code: ['m8 6-6 6 6 6m8-12 6 6-6 6M14 3l-4 18'],
  play: ['m8 4 12 8-12 8Z'],
  pause: ['M7 5h3v14H7ZM14 5h3v14h-3Z'],
  'skip-back': ['M5 5v14', 'm18 5-10 7 10 7Z'],
  monitor: ['M3 4h18v12H3Z', 'M12 16v4M8 20h8'],
  phone: ['M8 3h8v18H8Z', 'M10 6h4M11 18h2'],
  gamepad: ['M7 7h10c2 0 3 1.5 3.5 3.5l1 6c.4 2.4-2 3.4-3.5 1.5l-2-2H8l-2 2c-1.5 1.9-3.9.9-3.5-1.5l1-6C4 8.5 5 7 7 7Z', 'M7 10v4M5 12h4M16 11h.01M18 13h.01'],
}

export function editorIcon(h, name, size = 16) {
  return h('svg', { className: 'look2-icon', width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, focusable: false },
    ...(ICON_PATHS[name] || ICON_PATHS.container).map((d, key) => h('path', { key, d })))
}
