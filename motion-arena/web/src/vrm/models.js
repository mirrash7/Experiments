// Bundled VRM models (web/public/vrm). All licences permit commercial use and modification.
export const VRM_MODELS = [
  { file: 'Sakurada_Fumiriya.vrm', label: 'Sakurada Fumiriya (lead hero)', version: '0.x', licence: 'CC0 (VRoid Project)', credit: '' },
  { file: 'Base_Male.vrm', label: 'Base Male', version: '0.x', licence: 'CC0 (VRoid Project)', credit: '' },
  { file: 'Seed-san.vrm', label: 'Seed-san', version: '1.0', licence: 'VRM Public License 1.0', credit: 'Seed-san © VirtualCast, Inc.' },
  { file: 'VRM1_Constraint_Twist_Sample.vrm', label: 'VRM1 Constraint Twist Sample', version: '1.0', licence: 'VRM Public License 1.0', credit: '' },
];
export const DEFAULT_VRM = '/vrm/Sakurada_Fumiriya.vrm';
export const modelUrl = (file) => `/vrm/${file}`;
export function modelByUrl(url) { return VRM_MODELS.find((m) => url.endsWith('/' + m.file) || url === m.file) || null; }
