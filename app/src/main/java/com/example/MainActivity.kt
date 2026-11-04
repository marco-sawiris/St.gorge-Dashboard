package com.example

import android.annotation.SuppressLint
import android.os.Bundle
import android.util.Log
import android.util.Base64
import android.content.ContentValues
import android.os.Environment
import android.provider.MediaStore
import java.io.File
import java.io.FileOutputStream
import android.webkit.JavascriptInterface
import android.webkit.ConsoleMessage
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.os.Build
import android.content.Intent
import android.net.Uri
import android.widget.Toast
import android.content.ActivityNotFoundException
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
  private fun launchExternalIntent(intent: Intent, failureMessage: String) {
    webView.post {
      try {
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        webView.context.startActivity(intent)
      } catch (error: ActivityNotFoundException) {
        Log.e("DashboardWebView", failureMessage, error)
        Toast.makeText(webView.context, failureMessage, Toast.LENGTH_LONG).show()
      } catch (error: Exception) {
        Log.e("DashboardWebView", failureMessage, error)
        Toast.makeText(webView.context, failureMessage, Toast.LENGTH_LONG).show()
      }
    }
  }

  @JavascriptInterface
  fun openDialer(phone: String) {
    val digits = phone.filter { it.isDigit() }
    if (digits.isBlank()) {
      webView.post { Toast.makeText(webView.context, "رقم الهاتف غير متاح", Toast.LENGTH_SHORT).show() }
      return
    }
    launchExternalIntent(
      Intent(Intent.ACTION_DIAL, Uri.fromParts("tel", digits, null)),
      "تعذر فتح تطبيق الاتصال"
    )
  }

  @JavascriptInterface
  fun openWhatsApp(phone: String) {
    val digits = phone.filter { it.isDigit() }
    if (digits.isBlank()) {
      webView.post { Toast.makeText(webView.context, "رقم الهاتف غير متاح", Toast.LENGTH_SHORT).show() }
      return
    }
    val international = when {
      digits.startsWith("00") -> digits.drop(2)
      digits.startsWith("20") -> digits
      else -> "20" + digits.trimStart('0')
    }
    launchExternalIntent(
      Intent(Intent.ACTION_VIEW, Uri.parse("https://wa.me/$international")),
      "تعذر فتح واتساب أو المتصفح"
    )
  }

  @JavascriptInterface
  fun openExternalPage(url: String) {
    val uri = Uri.parse(url)
    val scheme = uri.scheme?.lowercase()
    val host = uri.host?.lowercase().orEmpty()
    val allowed = scheme == "https" && (
      host == "docs.google.com" ||
      host == "wa.me" ||
      host == "whatsapp.com" ||
      host.endsWith(".whatsapp.com")
    )
    if (!allowed) {
      webView.post { Toast.makeText(webView.context, "الرابط غير مسموح بفتحه", Toast.LENGTH_SHORT).show() }
      return
    }
    launchExternalIntent(
      Intent(Intent.ACTION_VIEW, uri),
      "تعذر فتح الرابط في المتصفح"
    )
  }

  @JavascriptInterface
  fun openGoogleSheet() {
    val uri = Uri.parse("https://docs.google.com/spreadsheets/d/15Nda4pGb3WdAfOuRTwRS9Fx822_EORgumOmhZcjTVt0/edit")
    launchExternalIntent(Intent(Intent.ACTION_VIEW, uri), "تعذر فتح ملف Google Sheets")
  }

  @JavascriptInterface
  fun saveBase64File(fileName: String, mimeType: String, base64Data: String): String {
    return try {
      val safeName = fileName.substringAfterLast('/').substringAfterLast('\\').replace(Regex("[^\\p{L}\\p{N}._-]"), "_")
      if (safeName.isBlank() || base64Data.isBlank()) return "بيانات الملف غير صالحة"
      val bytes = Base64.decode(base64Data, Base64.DEFAULT)
      if (bytes.isEmpty()) return "الملف فارغ"
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        val values = ContentValues().apply {
          put(MediaStore.Downloads.DISPLAY_NAME, safeName)
          put(MediaStore.Downloads.MIME_TYPE, mimeType)
          put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/StGorgeDashboard")
          put(MediaStore.Downloads.IS_PENDING, 1)
        }
        val resolver = webView.context.contentResolver
        val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
          ?: return "تعذر إنشاء ملف داخل مجلد التنزيلات"
        resolver.openOutputStream(uri)?.use { it.write(bytes) }
          ?: return "تعذر كتابة الملف"
        values.clear()
        values.put(MediaStore.Downloads.IS_PENDING, 0)
        resolver.update(uri, values, null, null)
      } else {
        val directory = File(webView.context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), "StGorgeDashboard")
        if (!directory.exists() && !directory.mkdirs()) return "تعذر إنشاء مجلد التنزيلات"
        FileOutputStream(File(directory, safeName)).use { it.write(bytes) }
      }
      "OK"
    } catch (error: Exception) {
      Log.e("DashboardWebView", "Unable to save exported file", error)
      error.message ?: "حدث خطأ أثناء حفظ الملف"
    }
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
            private fun openExternalUrl(url: String): Boolean {
              val uri = Uri.parse(url)
              val scheme = uri.scheme?.lowercase()
              if (scheme == "tel") {
                try {
                  context.startActivity(Intent(Intent.ACTION_DIAL, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                } catch (error: Exception) {
                  Log.e("DashboardWebView", "Unable to open dialer for $url", error)
                }
                return true
              }

              val host = uri.host?.lowercase().orEmpty()
              val isWhatsAppLink = scheme == "https" &&
                (host == "wa.me" || host == "whatsapp.com" || host.endsWith(".whatsapp.com"))
              if (isWhatsAppLink) {
                try {
                  context.startActivity(Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                } catch (error: Exception) {
                  Log.e("DashboardWebView", "Unable to open WhatsApp link $url", error)
                }
                return true
              }
              return false
            }

            override fun shouldOverrideUrlLoading(
              view: WebView?,
              request: WebResourceRequest?
            ): Boolean {
              val url = request?.url?.toString() ?: return false
              return openExternalUrl(url)
            }

            @Suppress("DEPRECATION")
            override fun shouldOverrideUrlLoading(view: WebView?, url: String?): Boolean {
              return url?.let { openExternalUrl(it) } ?: false
            }

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
