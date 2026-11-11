package br.truco.paulista;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.speech.tts.TextToSpeech;
import android.speech.tts.Voice;
import android.view.View;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.webkit.WebViewAssetLoader;

import java.util.Locale;
import java.util.Set;

/**
 * Truco Paulista: o jogo inteiro fica dentro do APK (assets/index.html).
 * - Contra o computador: roda 100% no aparelho, sem internet.
 * - Online: conversa com o servidor https://truco-online-vpr9.onrender.com quando há internet.
 * - Voz: usa o TextToSpeech do Android (preferindo voz masculina pt-BR).
 */
public class MainActivity extends Activity implements TextToSpeech.OnInitListener {

    private static final String START_URL = "https://appassets.androidplatform.net/assets/index.html";

    private WebView web;
    private TextToSpeech tts;
    private volatile boolean ttsOk = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        web = new WebView(this);
        web.setBackgroundColor(0xFF120B06);
        setContentView(web);
        hideSystemBars();

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setTextZoom(100);
        s.setSupportZoom(false);
        s.setAllowFileAccess(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);

        final WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return loader.shouldInterceptRequest(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                if ("appassets.androidplatform.net".equals(u.getHost())) return false;
                try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception ignored) { }
                return true;
            }
        });
        web.setWebChromeClient(new WebChromeClient());
        web.addJavascriptInterface(new Bridge(), "AndroidTTS");

        tts = new TextToSpeech(this, this);

        if (savedInstanceState != null) web.restoreState(savedInstanceState);
        else web.loadUrl(START_URL);
    }

    // ---------- voz nativa do Android
    @Override
    public void onInit(int status) {
        if (status != TextToSpeech.SUCCESS) return;
        Locale br = new Locale("pt", "BR");
        int r = tts.setLanguage(br);
        if (r == TextToSpeech.LANG_MISSING_DATA || r == TextToSpeech.LANG_NOT_SUPPORTED) tts.setLanguage(new Locale("pt"));
        try {
            Set<Voice> voices = tts.getVoices();
            Voice best = null;
            int bestScore = -1;
            if (voices != null) {
                for (Voice v : voices) {
                    Locale l = v.getLocale();
                    if (l == null || !"pt".equals(l.getLanguage())) continue;
                    String n = v.getName().toLowerCase(Locale.ROOT);
                    int sc = 0;
                    if ("BR".equalsIgnoreCase(l.getCountry())) sc += 4;
                    boolean female = n.contains("female") || n.contains("afs") || n.contains("ptc") || n.contains("feminin");
                    if (!female && (n.contains("ptd") || n.contains("pte") || n.contains("male") || n.contains("mascul"))) sc += 10;
                    if (!v.isNetworkConnectionRequired()) sc += 3; // funciona offline
                    sc += v.getQuality() / 100;
                    if (sc > bestScore) { bestScore = sc; best = v; }
                }
            }
            if (best != null) tts.setVoice(best);
        } catch (Exception ignored) { }
        ttsOk = true;
    }

    private class Bridge {
        @JavascriptInterface
        public void speak(String text, float pitch, float rate) {
            if (!ttsOk || text == null) return;
            tts.setPitch(Math.max(0.5f, Math.min(1.5f, pitch)));
            tts.setSpeechRate(Math.max(0.5f, Math.min(1.6f, rate)));
            tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, "truco");
        }

        @JavascriptInterface
        public boolean ready() { return ttsOk; }

        @JavascriptInterface
        public void vibrate(int ms) {
            try {
                Vibrator vb = (Vibrator) getSystemService(Context.VIBRATOR_SERVICE);
                if (vb == null) return;
                if (Build.VERSION.SDK_INT >= 26) vb.vibrate(VibrationEffect.createOneShot(Math.max(10, Math.min(400, ms)), VibrationEffect.DEFAULT_AMPLITUDE));
                else vb.vibrate(ms);
            } catch (Exception ignored) { }
        }
    }

    // ---------- tela cheia
    @SuppressWarnings("deprecation")
    private void hideSystemBars() {
        web.setSystemUiVisibility(View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                | View.SYSTEM_UI_FLAG_FULLSCREEN
                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) hideSystemBars();
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        web.saveState(outState);
    }

    @Override
    protected void onPause() { super.onPause(); web.onPause(); }

    @Override
    protected void onResume() { super.onResume(); web.onResume(); hideSystemBars(); }

    @SuppressWarnings("deprecation")
    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else moveTaskToBack(true); // não fecha a partida sem querer
    }

    @Override
    protected void onDestroy() {
        if (tts != null) { tts.stop(); tts.shutdown(); }
        if (web != null) web.destroy();
        super.onDestroy();
    }
}
