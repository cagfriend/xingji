package cn.tangjp.xingji;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.*;
import com.getcapacitor.annotation.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.Set;
import java.util.HashSet;
import java.util.Arrays;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.*;

/** Private JSON documents; no database, public storage permissions or server. */
@CapacitorPlugin(name = "LocalFiles")
public class LocalFilesPlugin extends Plugin {
    private static final Set<String> NAMES = new HashSet<>(Arrays.asList("trips.json", "config.json", "places.json", "aircraft-cache.json"));
    private static final int MAX_BYTES = 12 * 1024 * 1024;
    private final ExecutorService io = Executors.newSingleThreadExecutor();

    @PluginMethod public void call(PluginCall call) {
        String action = call.getString("action", "");
        if (action.equals("export")) {
            Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
            intent.addCategory(Intent.CATEGORY_OPENABLE);
            intent.setType("application/json");
            intent.putExtra(Intent.EXTRA_TITLE, call.getString("name", "行迹备份.json").replaceAll("[/\\\\]", "_"));
            getActivity().runOnUiThread(() -> startActivityForResult(call, intent, "exportResult"));
            return;
        }
        if (action.equals("import")) {
            Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
            intent.addCategory(Intent.CATEGORY_OPENABLE);
            intent.setType("*/*");
            getActivity().runOnUiThread(() -> startActivityForResult(call, intent, "importResult"));
            return;
        }
        io.execute(() -> {
            try {
                String name = call.getString("name", "");
                if (!NAMES.contains(name)) throw new IOException("不允许访问该文件");
                File file = new File(getContext().getFilesDir(), name);
                if (action.equals("read")) {
                    Object value = file.exists() ? readJson(new FileInputStream(file)) : JSONObject.NULL;
                    JSObject result = new JSObject(); result.put("value", value); call.resolve(result);
                } else if (action.equals("write")) {
                    Object value = call.getData().opt("value");
                    if (!(value instanceof JSONObject) && !(value instanceof JSONArray)) throw new IOException("仅可保存 JSON 对象或数组");
                    byte[] bytes = value.toString().getBytes(StandardCharsets.UTF_8);
                    if (bytes.length > MAX_BYTES) throw new IOException("存储文件超过 12 MB 限制");
                    File pending = new File(getContext().getFilesDir(), name + ".pending");
                    try (FileOutputStream output = new FileOutputStream(pending)) { output.write(bytes); output.getFD().sync(); }
                    if (file.exists()) {
                        // Keep a recoverable prior version, without ever treating corruption as an empty document.
                        File previous = new File(getContext().getFilesDir(), name + ".bak");
                        try (InputStream input = new FileInputStream(file); FileOutputStream output = new FileOutputStream(previous)) {
                            byte[] buffer = new byte[8192]; int count;
                            while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
                            output.getFD().sync();
                        }
                    }
                    if (!pending.renameTo(file)) throw new IOException("无法提交本地存储文件");
                    call.resolve();
                } else throw new IOException("未知文件操作");
            } catch (Exception error) { call.reject("本地文件操作失败：" + error.getMessage()); }
        });
    }

    private Object readJson(InputStream source) throws IOException, JSONException {
        if (source == null) throw new IOException("无法打开文件");
        try (InputStream input = source; ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192]; int count;
            while ((count = input.read(buffer)) != -1) {
                if (output.size() + count > MAX_BYTES) throw new IOException("文件超过 12 MB 限制");
                output.write(buffer, 0, count);
            }
            String text = output.toString(StandardCharsets.UTF_8.name());
            Object value = new JSONTokener(text).nextValue();
            if (!(value instanceof JSONObject) && !(value instanceof JSONArray)) throw new JSONException("不是有效的 JSON 备份");
            return value;
        }
    }

    @ActivityCallback private void exportResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) { call.reject("已取消导出"); return; }
        Uri uri = result.getData().getData();
        io.execute(() -> {
            try (OutputStream output = getContext().getContentResolver().openOutputStream(uri, "wt")) {
                if (output == null) throw new IOException("无法写入所选位置");
                Object value = call.getData().opt("value");
                if (!(value instanceof JSONObject) && !(value instanceof JSONArray)) throw new IOException("备份格式错误");
                byte[] bytes = value.toString().getBytes(StandardCharsets.UTF_8);
                if (bytes.length > MAX_BYTES) throw new IOException("备份超过 12 MB");
                output.write(bytes); call.resolve();
            } catch (Exception error) { call.reject("导出失败：" + error.getMessage()); }
        });
    }

    @ActivityCallback private void importResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) { call.reject("已取消导入"); return; }
        Uri uri = result.getData().getData();
        io.execute(() -> {
            try {
                Object value = readJson(getContext().getContentResolver().openInputStream(uri));
                JSObject reply = new JSObject(); reply.put("value", value); call.resolve(reply);
            } catch (Exception error) { call.reject("导入失败，现有数据未修改：" + error.getMessage()); }
        });
    }
}
