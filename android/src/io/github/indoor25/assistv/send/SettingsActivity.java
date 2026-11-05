package io.github.indoor25.assistv.send;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.StatusBarManager;
import android.content.ComponentName;
import android.graphics.drawable.Icon;
import android.os.Build;
import android.content.Intent;
import android.os.Bundle;
import android.text.InputType;
import android.view.View;
import android.view.ViewGroup.LayoutParams;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

/**
 * Единственный экран: адрес webhook, «Сохранить», «Отправить буфер обмена» и короткая справка.
 * Адрес можно задать и снаружи: adb shell am start -n io.github.indoor25.assistv.send/.SettingsActivity --es url "…"
 */
public class SettingsActivity extends Activity {
    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        String fromIntent = getIntent() != null ? getIntent().getStringExtra("url") : null;
        if (fromIntent != null) Sender.saveUrl(this, fromIntent);

        int pad = dp(20);
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(pad, pad, pad, pad);

        TextView label = new TextView(this);
        label.setText(R.string.url_label);
        box.addView(label);

        // сохранённый адрес — только для чтения (случайно не испортить), правка — кнопкой «Изменить»
        shown = new TextView(this);
        shown.setTextSize(16);
        android.content.res.TypedArray ta = obtainStyledAttributes(new int[]{android.R.attr.textColorPrimary});
        shown.setTextColor(ta.getColorStateList(0));
        ta.recycle();
        box.addView(shown, full(8));

        url = new EditText(this);
        url.setHint(R.string.url_hint);
        url.setSingleLine(true);
        url.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        box.addView(url, full(8));

        save = new Button(this);
        save.setText(R.string.save);
        save.setOnClickListener(v -> {
            String u = url.getText().toString().trim();
            if (u.isEmpty()) return;
            Sender.saveUrl(this, u);
            Sender.toast(this, getString(R.string.saved));
            showMode();
        });
        box.addView(save, full(12));

        LinearLayout row = new LinearLayout(this);
        edit = new Button(this);
        edit.setText(R.string.edit);
        edit.setOnClickListener(v -> {
            url.setText(Sender.url(this));
            editMode();
        });
        delete = new Button(this);
        delete.setText(R.string.delete);
        delete.setOnClickListener(v -> new AlertDialog.Builder(this)
                .setMessage(R.string.delete_ask)
                .setPositiveButton(R.string.delete, (d, w) -> {
                    Sender.saveUrl(this, "");
                    url.setText("");
                    editMode();
                })
                .setNegativeButton(android.R.string.cancel, null)
                .show());
        // две кнопки поровну по ширине, между ними зазор
        LinearLayout.LayoutParams half = new LinearLayout.LayoutParams(0, LayoutParams.WRAP_CONTENT, 1);
        LinearLayout.LayoutParams half2 = new LinearLayout.LayoutParams(0, LayoutParams.WRAP_CONTENT, 1);
        half2.leftMargin = dp(12);
        row.addView(edit, half);
        row.addView(delete, half2);
        box.addView(row, full(12));

        View line = new View(this);
        line.setBackgroundColor(0x33FFFFFF);
        LinearLayout.LayoutParams lineLp = full(28);
        lineLp.height = Math.max(1, dp(1));
        box.addView(line, lineLp);

        Button clip = new Button(this);
        clip.setText(R.string.send_clip);
        clip.setOnClickListener(v -> startActivity(new Intent(this, SendActivity.class).setAction(SendActivity.ACTION_CLIP)));
        box.addView(clip, full(28));

        // Android 13+: система сама спрашивает «Добавить плитку?» — не надо искать её в редакторе шторки
        if (Build.VERSION.SDK_INT >= 33) {
            Button tile = new Button(this);
            tile.setText(R.string.add_tile);
            tile.setOnClickListener(v -> {
                StatusBarManager sb = getSystemService(StatusBarManager.class);
                sb.requestAddTileService(new ComponentName(this, ClipTileService.class),
                        getString(R.string.action_label), Icon.createWithResource(this, R.drawable.ic_tile),
                        getMainExecutor(), result -> {
                            if (result == StatusBarManager.TILE_ADD_REQUEST_RESULT_TILE_ALREADY_ADDED)
                                Sender.toast(this, getString(R.string.tile_already));
                        });
            });
            box.addView(tile, full(12));
        }

        TextView help = new TextView(this);
        help.setText(R.string.help);
        help.setLineSpacing(0, 1.15f);
        box.addView(help, full(28));

        ScrollView scroll = new ScrollView(this);
        scroll.setFitsSystemWindows(true);
        scroll.addView(box);
        setContentView(scroll);
        if (Sender.url(this).isEmpty()) editMode(); else showMode();
    }

    private TextView shown;
    private EditText url;
    private Button save, edit, delete;

    private void showMode() {
        shown.setText(masked(Sender.url(this)));
        shown.setVisibility(View.VISIBLE);
        edit.setVisibility(View.VISIBLE);
        delete.setVisibility(View.VISIBLE);
        url.setVisibility(View.GONE);
        save.setVisibility(View.GONE);
    }

    private void editMode() {
        shown.setVisibility(View.GONE);
        edit.setVisibility(View.GONE);
        delete.setVisibility(Sender.url(this).isEmpty() ? View.GONE : View.VISIBLE);
        url.setVisibility(View.VISIBLE);
        save.setVisibility(View.VISIBLE);
    }

    /** Адрес webhook — секрет: на экране только начало id. */
    static String masked(String u) {
        int i = u.indexOf("/api/webhook/");
        if (i < 0) return u;
        int start = i + "/api/webhook/".length();
        int q = u.indexOf('?', start);
        String id = q < 0 ? u.substring(start) : u.substring(start, q);
        String shownId = id.length() > 6 ? id.substring(0, 6) + "…" : id;
        return u.substring(0, start) + shownId + (q < 0 ? "" : u.substring(q));
    }

    /** На всю ширину с отступом сверху. */
    private LinearLayout.LayoutParams full(int topDp) {
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(topDp);
        return lp;
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }
}
