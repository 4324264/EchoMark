import { SchemeTonalSpot, MaterialDynamicColors, Hct, argbFromHex, hexFromArgb } from './vendor/material-colors.mjs';

// Material 3 roles use Google's HCT / TonalSpot algorithm, not hand-picked RGB tints.
function updateThemeColors() {
  const accent = document.querySelector('#accent-color')?.value || '#28654a';
  const scheme = new SchemeTonalSpot(Hct.fromInt(argbFromHex(accent)), false, 0);
  const roles = {
    primary: 'primary', 'on-primary': 'onPrimary', 'primary-container': 'primaryContainer',
    'on-primary-container': 'onPrimaryContainer', 'secondary-container': 'secondaryContainer',
    'on-secondary-container': 'onSecondaryContainer', surface: 'surface',
    'surface-lowest': 'surfaceContainerLowest', 'surface-low': 'surfaceContainerLow',
    'surface-container': 'surfaceContainer', 'surface-high': 'surfaceContainerHigh',
    'on-surface': 'onSurface', 'on-surface-variant': 'onSurfaceVariant',
    outline: 'outline', 'outline-variant': 'outlineVariant', 'error-container': 'errorContainer',
    'on-error-container': 'onErrorContainer'
  };
  for (const [name, role] of Object.entries(roles)) document.documentElement.style.setProperty(`--md-${name}`, hexFromArgb(MaterialDynamicColors[role].getArgb(scheme)));
}
document.addEventListener('echomark-appearance', updateThemeColors);
updateThemeColors();
