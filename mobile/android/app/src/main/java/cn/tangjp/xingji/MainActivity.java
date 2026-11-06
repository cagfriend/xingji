package cn.tangjp.xingji;

import android.content.res.Configuration;
import android.os.Bundle;
import android.webkit.WebSettings;
import android.webkit.WebView;
import androidx.core.view.WindowCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(LocalFilesPlugin.class);
        super.onCreate(savedInstanceState);
        applyPageSystemBars();
    }

    @Override
    public void onResume() {
        super.onResume();
        applyPageSystemBars();
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        applyPageSystemBars();
    }

    @SuppressWarnings("deprecation")
    private void applyPageSystemBars() {
        int background = getColor(R.color.page_background);
        boolean lightTheme = (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK)
            != Configuration.UI_MODE_NIGHT_YES;

        // Android 15+ uses transparent system bars; keep the window backing in sync with the page.
        getWindow().setBackgroundDrawableResource(R.color.page_background);
        getWindow().getDecorView().setBackgroundColor(background);
        getWindow().setStatusBarColor(background);
        // Android 7 cannot draw dark navigation icons; retain their contrast there.
        getWindow().setNavigationBarColor(lightTheme && android.os.Build.VERSION.SDK_INT < 26
            ? 0xFF14243E : background);

        androidx.core.view.WindowInsetsControllerCompat bars =
            WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        bars.setAppearanceLightStatusBars(lightTheme);
        bars.setAppearanceLightNavigationBars(lightTheme);

        if (android.os.Build.VERSION.SDK_INT >= 29) {
            getWindow().setStatusBarContrastEnforced(false);
            getWindow().setNavigationBarContrastEnforced(false);
        }

        if (getBridge() != null && getBridge().getWebView() != null) {
            WebView webView = getBridge().getWebView();
            webView.setBackgroundColor(background);
            if (android.os.Build.VERSION.SDK_INT >= 29) {
                webView.setForceDarkAllowed(false);
            }
            disableWebViewDarkening(getBridge().getWebView().getSettings());
        }
    }

    @SuppressWarnings("deprecation")
    private void disableWebViewDarkening(WebSettings settings) {
        if (android.os.Build.VERSION.SDK_INT >= 33) {
            settings.setAlgorithmicDarkeningAllowed(false);
        } else if (android.os.Build.VERSION.SDK_INT >= 29) {
            settings.setForceDark(WebSettings.FORCE_DARK_OFF);
        }
    }
}
