package com.example

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.lifecycleScope
import org.json.JSONObject
import com.example.ui.theme.MyApplicationTheme
import com.google.firebase.Firebase
import com.google.firebase.FirebaseApp
import com.google.firebase.ai.ai
import com.google.firebase.appcheck.FirebaseAppCheck
import com.google.firebase.appcheck.debug.DebugAppCheckProviderFactory
import com.google.firebase.appcheck.recaptcha.RecaptchaAppCheckProviderFactory
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout

private const val TAG_APPCHECK = "AppCheckInit"
private const val DEBUG_TOKEN_EXTRA = "FIREBASE_APPCHECK_DEBUG_TOKEN"
private const val DEBUG_STORE_PREFIX = "com.google.firebase.appcheck.debug.store."
private const val DEBUG_SECRET_KEY = "com.google.firebase.appcheck.debug.DEBUG_SECRET"
private const val RECAPTCHA_SITE_KEY_RES = "recaptcha_site_key"

fun configureAppCheck(context: Context, intent: Intent?) {
  try {
    if (FirebaseApp.getApps(context).isEmpty()) {
      FirebaseApp.initializeApp(context)
    }

    if (BuildConfig.DEBUG) {
      val debugToken = intent?.getStringExtra(DEBUG_TOKEN_EXTRA)
      if (!debugToken.isNullOrEmpty()) {
        val persistenceKey = FirebaseApp.getInstance().persistenceKey
        val prefs = context.getSharedPreferences(
          "$DEBUG_STORE_PREFIX$persistenceKey",
          Context.MODE_PRIVATE
        )
        prefs.edit().putString(DEBUG_SECRET_KEY, debugToken).commit()
        Log.d(TAG_APPCHECK, "App Check debug secret configured successfully.")
      } else {
        Log.w(TAG_APPCHECK, "No debug token found in Intent extra.")
      }

      FirebaseAppCheck.getInstance().installAppCheckProviderFactory(
        DebugAppCheckProviderFactory.getInstance()
      )
      Log.d(TAG_APPCHECK, "DebugAppCheckProviderFactory installed.")
    } else {
      val resId = context.resources.getIdentifier(RECAPTCHA_SITE_KEY_RES, "string", context.packageName)
      if (resId != 0) {
        val siteKey = context.getString(resId)
        if (siteKey.isNotBlank()) {
          FirebaseAppCheck.getInstance().installAppCheckProviderFactory(
            RecaptchaAppCheckProviderFactory.getInstance(siteKey)
          )
          Log.d(TAG_APPCHECK, "RecaptchaAppCheckProviderFactory installed.")
        }
      }
    }
  } catch (e: Exception) {
    Log.e(TAG_APPCHECK, "Failed to initialize Firebase App Check", e)
  }
}

class MainActivity : ComponentActivity() {

  private val geminiModel by lazy {
    Firebase.ai.generativeModel("gemini-3.8-flash")
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    // 1. Mandatory App Check configuration before UI or ViewModels
    configureAppCheck(this, intent)

    enableEdgeToEdge()
    setContent {
      MyApplicationTheme {
        DashboardWebView(
          onAskGemini = { prompt, callbackId, webView ->
            lifecycleScope.launch(Dispatchers.IO) {
              try {
                val response = withTimeout(60_000L) {
                  geminiModel.generateContent(prompt)
                }
                val text = response.text ?: "لا يوجد رد من النموذج"
                withContext(Dispatchers.Main) {
                  val quotedText = JSONObject.quote(text)
                  webView.evaluateJavascript(
                    "window.onGeminiResponse && window.onGeminiResponse('$callbackId', true, $quotedText);",
                    null
                  )
                }
              } catch (e: Exception) {
                Log.e("GeminiAPI", "Failed to generate AI response", e)
                withContext(Dispatchers.Main) {
                  val errorMsg = e.localizedMessage ?: "حدث خطأ أثناء معالجة الطلب"
                  val quotedError = JSONObject.quote(errorMsg)
                  webView.evaluateJavascript(
                    "window.onGeminiResponse && window.onGeminiResponse('$callbackId', false, $quotedError);",
                    null
                  )
                }
              }
            }
          }
        )
      }
    }
  }
}

class GeminiWebBridge(
  private val webView: WebView,
  private val onAskGemini: (prompt: String, callbackId: String, webView: WebView) -> Unit
) {
  @JavascriptInterface
  fun askGemini(prompt: String, callbackId: String) {
    onAskGemini(prompt, callbackId, webView)
  }

  @JavascriptInterface
  fun isAvailable(): Boolean = true
}

@SuppressLint("SetJavaScriptEnabled")
@Composable
fun DashboardWebView(
  onAskGemini: (prompt: String, callbackId: String, webView: WebView) -> Unit
) {
  var webViewInstance by remember { mutableStateOf<WebView?>(null) }

  BackHandler(enabled = true) {
    val wv = webViewInstance
    if (wv != null && wv.canGoBack()) {
      wv.goBack()
    } else {
      wv?.evaluateJavascript(
        "(function() { if (typeof closeSidebar === 'function' && document.getElementById('sidebar') && document.getElementById('sidebar').classList.contains('open')) { closeSidebar(); return true; } if (typeof currentActiveEditingId !== 'undefined' && currentActiveEditingId !== null) { flipCardBack(currentActiveEditingId); return true; } return false; })()",
        null
      )
    }
  }

  Box(
    modifier = Modifier
      .fillMaxSize()
      .background(Color(0xFF0B1E2C))
      .statusBarsPadding()
  ) {
    AndroidView(
      modifier = Modifier.fillMaxSize(),
      factory = { context ->
        WebView(context).apply {
          settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            allowFileAccess = true
            allowContentAccess = true
            mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            useWideViewPort = true
            loadWithOverviewMode = true
            cacheMode = WebSettings.LOAD_DEFAULT
          }
          webViewClient = WebViewClient()
          webChromeClient = WebChromeClient()

          // Add Gemini Web Bridge for seamless AI integration
          addJavascriptInterface(GeminiWebBridge(this, onAskGemini), "AndroidGemini")

          loadUrl("file:///android_asset/index.html")
          webViewInstance = this
        }
      },
      update = {
        webViewInstance = it
      }
    )
  }
}
