param([switch]$DebugBuild)
$ErrorActionPreference = 'Stop'
$mobileRoot = $PSScriptRoot
Push-Location $mobileRoot
try {
    $taskJava = Join-Path $mobileRoot 'toolchain/jdk/jdk-21.0.12.1+1'
    $taskSdk = Join-Path $mobileRoot 'toolchain/android-sdk'
    if (!(Test-Path "$taskJava/bin/java.exe")) { throw '缺少 JDK 21；请配置 toolchain/jdk 或调整脚本中的 JDK 路径。' }
    if (!(Test-Path "$taskSdk/platforms/android-36/android.jar") -or !(Test-Path "$taskSdk/build-tools/35.0.0/aapt2.exe")) { throw '缺少 Android SDK 36 或 Build Tools 35。' }
    $env:JAVA_HOME = $taskJava
    $env:ANDROID_HOME = $taskSdk
    $env:GRADLE_USER_HOME = Join-Path $mobileRoot 'toolchain/gradle-home'
    node build-web.mjs
    if ($LASTEXITCODE -ne 0) { throw '手机页面打包失败' }
    node node_modules/@capacitor/cli/bin/capacitor sync android
    if ($LASTEXITCODE -ne 0) { throw 'Android 资源同步失败' }
    $task = if ($DebugBuild) { 'assembleDebug' } else { 'assembleRelease' }
    Push-Location android
    try {
        & "$mobileRoot/toolchain/gradle/gradle-8.14.3/bin/gradle.bat" $task 'lintRelease' '--no-daemon' '-Dorg.gradle.internal.http.connectionTimeout=120000' '-Dorg.gradle.internal.http.socketTimeout=120000'
        if ($LASTEXITCODE -ne 0) { throw 'Android 编译/检查失败' }
    } finally { Pop-Location }
} finally { Pop-Location }
