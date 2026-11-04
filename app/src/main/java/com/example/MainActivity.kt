package com.example

import android.annotation.SuppressLint
import android.os.Bundle
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.ConsoleMessage
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
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
import com.example.ui.theme.MyApplicationTheme

class MainActivity : ComponentActivity() {

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
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
        DashboardWebView()
      }
    }
  }
}

class ServiceWebBridge(private val webView: WebView) {
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
fun DashboardWebView() {
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
          webViewClient = object : WebViewClient() {
            override fun onReceivedError(
              view: WebView?,
              request: WebResourceRequest?,
              error: WebResourceError?
            ) {
              super.onReceivedError(view, request, error)
              Log.e(
                "DashboardWebView",
                "Resource load failed: ${request?.url} | code=${error?.errorCode} | ${error?.description}"
              )
            }

            @Suppress("DEPRECATION")
            override fun onReceivedError(
              view: WebView?,
              errorCode: Int,
              description: String?,
              failingUrl: String?
            ) {
              super.onReceivedError(view, errorCode, description, failingUrl)
              Log.e(
                "DashboardWebView",
                "Legacy resource load failed: $failingUrl | code=$errorCode | $description"
              )
            }
          }
          webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(consoleMessage: ConsoleMessage?): Boolean {
              consoleMessage?.let { message ->
                val details = message.message() + " -- line " + message.lineNumber() + " (" + message.sourceId() + ")"
                when (message.messageLevel()) {
                  ConsoleMessage.MessageLevel.ERROR -> Log.e("DashboardJS", details)
                  ConsoleMessage.MessageLevel.WARNING -> Log.w("DashboardJS", details)
                  else -> Log.d("DashboardJS", details)
                }
              }
              return true
            }
          }

          // منع تحديد النصوص وظهور شريط النسخ والمشاركة في الأماكن غير القابلة للتعديل
          setOnLongClickListener { v ->
            val result = (v as? WebView)?.hitTestResult
            result?.type != WebView.HitTestResult.EDIT_TEXT_TYPE
          }

          // Add native service bridge
          addJavascriptInterface(ServiceWebBridge(this), "AndroidServiceBridge")

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
