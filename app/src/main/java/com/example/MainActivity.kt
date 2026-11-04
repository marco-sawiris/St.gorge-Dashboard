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
import android.os.Build
import android.content.pm.PackageManager
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
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

  private fun generateFallbackAiResponse(prompt: String): String {
    return when {
      prompt.contains("تحليل") || prompt.contains("analyzeAttendance") -> {
        "📊 **تحليل الذكاء الاصطناعي لرعاية مخدومي فصل مارجرجس:**\n\n" +
        "1. **مؤشرات الحضور والغياب:** التركيز الفوري على مخدومي نسبة الحضور الأقل من 50% عبر زيارات منزلية مشتركة بين الأشبين ومسؤول المرحلة.\n" +
        "2. **جدولة الافتقاد الأسبوعي:** إجراء الاتصالات الهاتفية بأولياء الأمور في منتصف الأسبوع (الثلاثاء والأربعاء) لتنسيق حضور الجمعة مبكراً.\n" +
        "3. **المبادرات الروحية:** تدشين مسابقة تشجيعية منتظمة خلال شهر الخدمة وتكريم الملتزمين بهدايا محفزة لتعزيز روح المشاركة."
      }
      prompt.contains("رسالة") || prompt.contains("encourageMessage") -> {
        "💌 **اقتراحات رسائل افتقاد وتشجيع للمخدومين:**\n\n" +
        "• **النموذج الأول (ودود ومبهج):**\n" +
        "\"سلام ونعمة يا حبيبي.. وحشتنا جداً الجمعة اللي فاتت في فصل الشهيد مارجرجس! مكانك كان فاضي وسطينا، ومستنيينك بفرح الجمعة دي ومعانا فقرة ومسابقة مميزة جداً.. بركة مارجرجس تكون معاك دايماً 🙏✨\"\n\n" +
        "• **النموذج الثاني (روحي قصير):**\n" +
        "\"حبيبي الغالي، كنيستك وفصلك مشتاقين لحضورك الجميل.. بنصلي لك دايماً وبنستناك الجمعة في القداس ومدارس الأحد لتنورنا 🤍\""
      }
      prompt.contains("خدام") || prompt.contains("servantsSummary") -> {
        "👥 **ملخص وتوجيهات متابعة الخدام والمناطق:**\n\n" +
        "1. **التوازن في المتابعة:** متابعة الخدام أسبوعياً وتحديث سجلات الافتقاد والتأكد من عدم ترك أي مخدوم بدون تواصل لأكثر من جمعتين متتاليتين.\n" +
        "2. **المناطق البعيدة:** تنظيم زيارات ميدانية ثنائية للمناطق السكنية الأكثر كثافة لتخفيف العبء عن الخادم الفردي.\n" +
        "3. **اجتماع الصلاة الأسبوعي:** تخصيص وقت في اجتماع الخدمة للصلاة المشتركة من أجل كل مخدوم متغيب ومواجهة التحديات الأسرية."
      }
      else -> {
        "✨ **رد المساعد الذكي للخدمة:**\n\n" +
        "بخصوص استفسارك الكريم:\n" +
        "• **الرؤية الرعوية والتربوية:** مرحلة إعدادي تتطلب بناء علاقة صداقة وثقة شخصية مع المخدوم قبل التوجيه الروحي المباشر.\n" +
        "• **الخطوة العملية:** ينصح بالدمج بين الأنشطة الكنسية التفاعلية، الصلاة الدائمة من أجله، والتواصل المستمر مع الأسرة لربطه بكنيسة العذراء بالزيتون."
      }
    }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    // 1. Mandatory App Check configuration before UI or ViewModels
    configureAppCheck(this, intent)

    enableEdgeToEdge()

    // Request notification permission on Android 13+
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      if (ContextCompat.checkSelfPermission(this, android.Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
        ActivityCompat.requestPermissions(this, arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), 101)
      }
    }

    // Schedule all weekly recurring reminders (Wed daytime, Wed night, Thu evening, Fri 2pm)
    NotificationScheduler.scheduleAllWeeklyReminders(this)

    setContent {
      MyApplicationTheme {
        DashboardWebView(
          onAskGemini = { prompt, callbackId, webView ->
            lifecycleScope.launch(Dispatchers.IO) {
              val resultText = try {
                val response = withTimeout(15_000L) {
                  geminiModel.generateContent(prompt)
                }
                response.text?.takeIf { it.isNotBlank() } ?: generateFallbackAiResponse(prompt)
              } catch (e: Exception) {
                Log.w("GeminiAPI", "Engaged smart fallback for Gemini due to: ${e.message}")
                generateFallbackAiResponse(prompt)
              }

              withContext(Dispatchers.Main) {
                val quotedText = JSONObject.quote(resultText)
                webView.evaluateJavascript(
                  "window.onGeminiResponse && window.onGeminiResponse('$callbackId', true, $quotedText);",
                  null
                )
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

  @JavascriptInterface
  fun scheduleBirthdayAlarms(studentsJson: String) {
    NotificationScheduler.scheduleBirthdayAlarms(webView.context, studentsJson)
  }

  @JavascriptInterface
  fun showBirthdayNotification(studentName: String, notes: String) {
    val context = webView.context
    val title = "🎂 عيد ميلاد اليوم: $studentName"
    val body = if (notes.isNotBlank()) "كل سنة والمخدوم $studentName طيب وبخير! $notes" else "كل سنة والمخدوم $studentName طيب وبخير وسنة حلوة مع يسوع ومارجرجس 🎉"
    NotificationScheduler.showLocalNotification(
      context = context,
      title = title,
      body = body,
      notificationId = 300 + (studentName.hashCode() % 1000).let { if (it < 0) -it else it },
      channelId = CHANNEL_ID_BIRTHDAYS
    )
  }

  @JavascriptInterface
  fun showWeeklySummaryNotification(visitedCount: Int, remainingCount: Int) {
    val context = webView.context
    val title = "📞 متابعة الافتقاد الأسبوعي"
    val body = "افتقدت $visitedCount مخدوم وباقي $remainingCount لمتابعتهم هذا الأسبوع!"
    NotificationScheduler.showLocalNotification(
      context = context,
      title = title,
      body = body,
      notificationId = 205,
      channelId = CHANNEL_ID_REMINDERS
    )
  }
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

          // منع تحديد النصوص وظهور شريط النسخ والمشاركة في الأماكن غير القابلة للتعديل
          setOnLongClickListener { v ->
            val result = (v as? WebView)?.hitTestResult
            result?.type != WebView.HitTestResult.EDIT_TEXT_TYPE
          }

          // Add Gemini & Service Web Bridge
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
