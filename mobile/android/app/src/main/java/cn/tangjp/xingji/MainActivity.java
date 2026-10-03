package cn.tangjp.xingji;

import com.getcapacitor.BridgeActivity;
import android.os.Bundle;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import androidx.core.view.WindowCompat;

public class MainActivity extends BridgeActivity {
    @Override public void onCreate(Bundle savedInstanceState) {
        registerPlugin(LocalFilesPlugin.class);
        super.onCreate(savedInstanceState);
        applyPageSystemBars();
    }

    @Override public void onResume() {
        super.onResume();
        applyPageSystemBars();
    }

    @SuppressWarnings("deprecation")
    private void applyPageSystemBars() {
        int background = Color.rgb(243, 245, 250);
        // Android 15+ makes system bars transparent; color the backing window as well.
        getWindow().setBackgroundDrawable(new ColorDrawable(background));
        getWindow().getDecorView().setBackgroundColor(background);
        getWindow().setStatusBarColor(background);
        getWindow().setNavigationBarColor(background);
        WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView()).setAppearanceLightStatusBars(true);
        WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView()).setAppearanceLightNavigationBars(true);
        if (android.os.Build.VERSION.SDK_INT >= 29) {
            getWindow().setStatusBarContrastEnforced(false);
            getWindow().setNavigationBarContrastEnforced(false);
        }
    }
}
