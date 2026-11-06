package cn.tangjp.xingji;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.graphics.BitmapFactory;
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
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import org.json.*;

/** Private JSON documents; no database, public storage permissions or server. */
@CapacitorPlugin(name = "LocalFiles")
public class LocalFilesPlugin extends Plugin {
    private static final Set<String> NAMES = new HashSet<>(Arrays.asList("trips.json", "config.json", "places.json", "aircraft-cache.json"));
    private static final int MAX_BYTES = 12 * 1024 * 1024;
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final ExecutorService photoIo = Executors.newFixedThreadPool(2);

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
        if (action.equals("cachePhoto")) { photoIo.execute(() -> cachePhoto(call)); return; }
        if (action.equals("photoExists")) {
            String value = call.getString("uri", ""); File dir = new File(getContext().getFilesDir(), "aircraft-photos");
            Uri parsed = Uri.parse(value); File candidate = new File(parsed.getPath() == null ? "" : parsed.getPath()); JSObject result = new JSObject();
            try { boolean exists = "file".equals(parsed.getScheme()) && candidate.getCanonicalPath().startsWith(dir.getCanonicalPath() + File.separator) && validImage(candidate); result.put("exists", exists); call.resolve(result); }
            catch (Exception error) { result.put("exists", false); call.resolve(result); }
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

    private void cachePhoto(PluginCall call) {
        File target = null;
        File pending = null;
        try {
            String source = call.getString("url", "");
            boolean force = call.getBoolean("force", false);
            URL url = checkedPhotoUrl(source);
            String hash = hex(MessageDigest.getInstance("SHA-256").digest(source.getBytes(StandardCharsets.UTF_8)));
            File dir = new File(getContext().getFilesDir(), "aircraft-photos");
            if (!dir.exists() && !dir.mkdirs()) throw new IOException("无法创建照片缓存目录");
            target = new File(dir, hash + ".img");
            if (validImage(target) && !force) { resolvePhoto(call, Uri.fromFile(target)); return; }
            pending = new File(dir, hash + "." + Thread.currentThread().getId() + ".pending");
            HttpURLConnection connection = null;
            try {
                for (int redirects = 0; ; redirects++) {
                    connection = (HttpURLConnection) url.openConnection();
                    connection.setInstanceFollowRedirects(false); connection.setConnectTimeout(8000); connection.setReadTimeout(12000);
                    connection.setRequestProperty("User-Agent", "Xingji/1.0 (https://github.com/cagfriend/xingji)");
                    int status = connection.getResponseCode();
                    if (status >= 300 && status < 400) {
                        if (redirects >= 3) throw new IOException("照片重定向次数过多");
                        String location = connection.getHeaderField("Location"); connection.disconnect(); connection = null;
                        if (location == null) throw new IOException("照片重定向地址无效");
                        url = checkedPhotoUrl(new URL(url, location).toString()); continue;
                    }
                    if (status < 200 || status >= 300) throw new IOException("照片下载失败");
                    if (connection.getContentLengthLong() > 4L * 1024 * 1024) throw new IOException("照片超过 4 MB");
                    try (InputStream in = connection.getInputStream(); FileOutputStream out = new FileOutputStream(pending)) {
                        byte[] buf = new byte[8192]; int n; long total = 0;
                        while ((n = in.read(buf)) != -1) { total += n; if (total > 4L * 1024 * 1024) throw new IOException("照片超过 4 MB"); out.write(buf, 0, n); }
                        out.getFD().sync();
                    }
                    break;
                }
            } finally { if (connection != null) connection.disconnect(); }
            if (!validImage(pending)) { pending.delete(); throw new IOException("下载内容不是有效图片"); }
            if (!pending.renameTo(target)) { pending.delete(); throw new IOException("无法保存照片"); }
            resolvePhoto(call, Uri.fromFile(target));
        } catch (Exception error) {
            if (target != null && validImage(target)) { resolvePhoto(call, Uri.fromFile(target)); return; }
            call.reject("照片缓存失败：" + error.getMessage());
        } finally { if (pending != null && pending.exists()) pending.delete(); }
    }
    private URL checkedPhotoUrl(String value) throws Exception {
        URL url = new URL(value); String host = url.getHost().toLowerCase(java.util.Locale.ROOT);
        boolean allowed = host.equals("t.plnspttrs.net") || host.equals("cdn.planespotters.net") || host.equals("plnspttrs.net") || host.endsWith(".plnspttrs.net") || host.endsWith(".planespotters.net");
        if (!"https".equalsIgnoreCase(url.getProtocol()) || !allowed || url.getUserInfo() != null) throw new IOException("照片地址不受支持");
        return url;
    }
    private boolean validImage(File file) {
        if (file == null || !file.isFile() || file.length() == 0 || file.length() > 4L * 1024 * 1024) return false;
        BitmapFactory.Options options = new BitmapFactory.Options(); options.inJustDecodeBounds = true;
        BitmapFactory.decodeFile(file.getAbsolutePath(), options); return options.outWidth > 0 && options.outHeight > 0;
    }
    private String hex(byte[] bytes) { StringBuilder out = new StringBuilder(); for (byte b : bytes) out.append(String.format(java.util.Locale.ROOT, "%02x", b)); return out.toString(); }
    private void resolvePhoto(PluginCall call, Uri uri) { JSObject result = new JSObject(); result.put("localUri", uri.toString()); call.resolve(result); }

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
