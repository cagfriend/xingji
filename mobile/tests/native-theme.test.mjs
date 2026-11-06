import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const mobileRoot = new URL('../', import.meta.url);
const readMobileFile = (path) => readFile(new URL(path, mobileRoot), 'utf8');

test('native theme resources provide matching light and dark page backgrounds', async () => {
  const [lightColors, darkColors, lightStyles, darkStyles] = await Promise.all([
    readMobileFile('android/app/src/main/res/values/colors.xml'),
    readMobileFile('android/app/src/main/res/values-night/colors.xml'),
    readMobileFile('android/app/src/main/res/values/styles.xml'),
    readMobileFile('android/app/src/main/res/values-night/styles.xml'),
  ]);

  assert.match(lightColors, /name="page_background">#F3F5FA/i);
  assert.match(darkColors, /name="page_background">#10141C/i);
  assert.match(lightStyles, /Theme\.AppCompat\.DayNight\.NoActionBar/);
  assert.match(lightStyles, /android:windowLightStatusBar">true/);
  assert.doesNotMatch(lightStyles, /android:windowLightNavigationBar/);
  assert.match(darkStyles, /android:windowLightStatusBar">false/);
  assert.doesNotMatch(darkStyles, /android:windowLightNavigationBar/);
});

test('launch screen and native window use the qualified page background', async () => {
  const [lightStyles, darkStyles, activity] = await Promise.all([
    readMobileFile('android/app/src/main/res/values/styles.xml'),
    readMobileFile('android/app/src/main/res/values-night/styles.xml'),
    readMobileFile('android/app/src/main/java/cn/tangjp/xingji/MainActivity.java'),
  ]);

  assert.match(lightStyles, /windowSplashScreenBackground">@color\/page_background/);
  assert.match(lightStyles, /android:windowBackground">@color\/page_background/);
  assert.match(darkStyles, /android:navigationBarColor">@color\/page_background/);
  assert.match(activity, /onConfigurationChanged\(Configuration newConfig\)/);
  assert.match(activity, /setBackgroundDrawableResource\(R\.color\.page_background\)/);
  assert.match(activity, /webView\.setBackgroundColor\(background\)/);
});

test('Capacitor system bars follow the system theme and WebView darkening is disabled', async () => {
  const [config, activity] = await Promise.all([
    readMobileFile('capacitor.config.json'),
    readMobileFile('android/app/src/main/java/cn/tangjp/xingji/MainActivity.java'),
  ]);

  assert.match(config, /"SystemBars"\s*:\s*\{\s*"style"\s*:\s*"DEFAULT"/);
  assert.doesNotMatch(config, /"style"\s*:\s*"LIGHT"/);
  assert.match(activity, /setAppearanceLightStatusBars\(lightTheme\)/);
  assert.match(activity, /setAppearanceLightNavigationBars\(lightTheme\)/);
  assert.match(activity, /lightTheme && android\.os\.Build\.VERSION\.SDK_INT < 26/);
  assert.match(activity, /SDK_INT\s*>=\s*33[\s\S]*?setAlgorithmicDarkeningAllowed\(false\)/);
  assert.match(activity, /SDK_INT\s*>=\s*29[\s\S]*?setForceDark\(WebSettings\.FORCE_DARK_OFF\)/);
  assert.match(activity, /SDK_INT\s*>=\s*29[\s\S]*?setForceDarkAllowed\(false\)/);
  assert.doesNotMatch(activity, /androidx\.webkit/);
});
