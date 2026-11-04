package com.example

import android.app.AlarmManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import java.util.Calendar

const val CHANNEL_ID_REMINDERS = "st_gorge_service_reminders"
const val CHANNEL_ID_BIRTHDAYS = "st_gorge_birthday_reminders"
const val EXTRA_NOTIFICATION_TITLE = "extra_notif_title"
const val EXTRA_NOTIFICATION_BODY = "extra_notif_body"
const val EXTRA_NOTIFICATION_ID = "extra_notif_id"

const val ACTION_BIRTHDAY = "com.example.ACTION_BIRTHDAY"
const val EXTRA_STUDENT_NAME = "extra_student_name"
const val EXTRA_BIRTHDAY_NOTES = "extra_birthday_notes"

class ReminderReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent?) {
    val action = intent?.action
    if (action == Intent.ACTION_BOOT_COMPLETED) {
      Log.d("ReminderReceiver", "Device rebooted, rescheduling weekly alarms")
      NotificationScheduler.scheduleAllWeeklyReminders(context)
      return
    }

    if (action == ACTION_BIRTHDAY) {
      val name = intent.getStringExtra(EXTRA_STUDENT_NAME) ?: "مخدوم"
      val title = "🎂 عيد ميلاد اليوم: $name"
      val body = "كل سنة والمخدوم $name طيب وبخير وسنة حلوة مع يسوع ومارجرجس 🎉\n\nاضغط هنا لنسخ رسالة التهنئة للواتساب"
      
      // اقتراح رسالة تهنئة
      val greeting = "كل سنة وأنت طيب يا $name، يا بطل! سنة حلوة مع يسوع ومارجرجس، ومستنيين نشوفك الجمعة في الفصل وتنورنا! 🎂🎉✨"
      
      NotificationScheduler.showLocalNotificationWithAction(
        context, title, body, greeting, (300 + name.hashCode() % 1000).let { if (it < 0) -it else it }, CHANNEL_ID_BIRTHDAYS
      )
      return
    }

    val title = intent?.getStringExtra(EXTRA_NOTIFICATION_TITLE) ?: "فصل الشهيد مارجرجس"
    val body = intent?.getStringExtra(EXTRA_NOTIFICATION_BODY) ?: "تذكير جديد لخدمة فصل مارجرجس"
    val notifId = intent?.getIntExtra(EXTRA_NOTIFICATION_ID, 100) ?: 100

    NotificationScheduler.showLocalNotification(context, title, body, notifId, CHANNEL_ID_REMINDERS)
  }
}

class NotificationActionReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent?) {
    if (intent?.action == "com.example.ACTION_COPY_GREETING") {
      val greeting = intent.getStringExtra("greeting") ?: ""
      val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
      val clip = android.content.ClipData.newPlainText("Birthday Greeting", greeting)
      clipboard.setPrimaryClip(clip)
      
      // Notify user
      android.widget.Toast.makeText(context, "تم نسخ التهنئة للواتساب!", android.widget.Toast.LENGTH_SHORT).show()
      
      // Cancel notification
      val notificationManager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      notificationManager.cancel(intent.getIntExtra(EXTRA_NOTIFICATION_ID, 100))
    }
  }
}

object NotificationScheduler {
  private const val TAG = "NotificationScheduler"

  fun createNotificationChannels(context: Context) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val notificationManager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

      val remindersChannel = NotificationChannel(
        CHANNEL_ID_REMINDERS,
        "تنبيهات الخدمة والافتقاد الأسبوعية",
        NotificationManager.IMPORTANCE_HIGH
      ).apply {
        description = "تنبيهات أسبوعية مستمرة للافتقاد والتحضير وتسجيل الحضور"
        enableVibration(true)
      }

      val birthdayChannel = NotificationChannel(
        CHANNEL_ID_BIRTHDAYS,
        "تنبيهات أعياد ميلاد المخدومين",
        NotificationManager.IMPORTANCE_HIGH
      ).apply {
        description = "تنبيهات أعياد ميلاد مخدومي فصل مارجرجس"
        enableVibration(true)
      }

      notificationManager.createNotificationChannel(remindersChannel)
      notificationManager.createNotificationChannel(birthdayChannel)
    }
  }

  fun showLocalNotification(
    context: Context,
    title: String,
    body: String,
    notificationId: Int,
    channelId: String = CHANNEL_ID_REMINDERS
  ) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      val permission = ContextCompat.checkSelfPermission(context, android.Manifest.permission.POST_NOTIFICATIONS)
      if (permission != PackageManager.PERMISSION_GRANTED) {
        Log.w(TAG, "POST_NOTIFICATIONS not granted, skipping notification display.")
        return
      }
    }

    createNotificationChannels(context)

    val launchIntent = Intent(context, MainActivity::class.java).apply {
      flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
    }
    val pendingIntent = PendingIntent.getActivity(
      context,
      notificationId,
      launchIntent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )

    val notification = NotificationCompat.Builder(context, channelId)
      .setSmallIcon(R.drawable.app_icon_fg)
      .setContentTitle(title)
      .setContentText(body)
      .setStyle(NotificationCompat.BigTextStyle().bigText(body))
      .setPriority(NotificationCompat.PRIORITY_HIGH)
      .setContentIntent(pendingIntent)
      .setAutoCancel(true)
      .build()

    val notificationManager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    notificationManager.notify(notificationId, notification)
  }

  fun showLocalNotificationWithAction(
    context: Context,
    title: String,
    body: String,
    greeting: String,
    notificationId: Int,
    channelId: String = CHANNEL_ID_REMINDERS
  ) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      if (ContextCompat.checkSelfPermission(context, android.Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
    }
    createNotificationChannels(context)

    // Action to copy greeting to clipboard
    val copyIntent = Intent(context, NotificationActionReceiver::class.java).apply {
      action = "com.example.ACTION_COPY_GREETING"
      putExtra("greeting", greeting)
    }
    val copyPendingIntent = PendingIntent.getBroadcast(
      context, notificationId, copyIntent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )

    val notification = NotificationCompat.Builder(context, channelId)
      .setSmallIcon(R.drawable.app_icon_fg)
      .setContentTitle(title)
      .setContentText(body)
      .setStyle(NotificationCompat.BigTextStyle().bigText(body))
      .setPriority(NotificationCompat.PRIORITY_HIGH)
      .addAction(0, "نسخ التهنئة للواتساب", copyPendingIntent)
      .setAutoCancel(true)
      .build()

    val notificationManager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    notificationManager.notify(notificationId, notification)
  }

  fun scheduleAllWeeklyReminders(context: Context) {
    createNotificationChannels(context)

    // الأربعاء 11:00 ص — تذكير الافتقاد
    scheduleWeeklyAlarm(context, 201, Calendar.WEDNESDAY, 11, 0, "📞 تذكير الافتقاد الأسبوعي", "منتصف الأسبوع: تابع مخدوميك وافتقد باقي الأسماء لتنسيق الحضور والقداس!")

    // الأربعاء 8:30 م — تذكير التحضير
    scheduleWeeklyAlarm(context, 202, Calendar.WEDNESDAY, 20, 30, "📖 تذكير بتحضير درس مدارس الأحد", "وقت الصلاة والتحضير لخدمة أولادنا الحبيبة.. جهّز درسك بفرح ✨")

    // الخميس 5:00 م — تذكير تسجيل الافتقاد
    scheduleWeeklyAlarm(context, 203, Calendar.THURSDAY, 17, 0, "📝 سجل الافتقاد", "لا تنسَ تسجيل آخر عملية افتقاد قمت بها هذا الأسبوع!")

    // الخميس 6:00 م — تذكير أخير للافتقاد
    scheduleWeeklyAlarm(context, 204, Calendar.THURSDAY, 18, 0, "🕊️ تذكير أخير للافتقاد قبل الجمعة", "اطمئن على باقي المخدومين تليفونياً وأكد عليهم ميعاد القداس غداً!")

    // الجمعة 2:00 م — تسجيل الحضور والغياب
    scheduleWeeklyAlarm(context, 205, Calendar.FRIDAY, 14, 0, "📋 تسجيل الحضور والغياب", "الساعة 2 ظهراً: حان موعد تسجيل الحضور والغياب لمخدوميك ✅")
  }

  fun scheduleBirthdayAlarms(context: Context, studentsJson: String) {
    val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as? AlarmManager ?: return
    val students = org.json.JSONArray(studentsJson)

    for (i in 0 until students.length()) {
      val s = students.getJSONObject(i)
      val name = s.getString("name")
      val birthDate = s.optString("birthDate", "")
      if (birthDate.isEmpty()) continue
      
      try {
        val parts = birthDate.split("/")
        if (parts.size < 2) continue
        val day = parts[0].toInt()
        val month = parts[1].toInt() - 1 

        val alarmTime = Calendar.getInstance().apply {
          set(Calendar.MONTH, month)
          set(Calendar.DAY_OF_MONTH, day)
          set(Calendar.HOUR_OF_DAY, 8)
          set(Calendar.MINUTE, 0)
          set(Calendar.SECOND, 0)
          set(Calendar.MILLISECOND, 0)
          if (timeInMillis < System.currentTimeMillis()) {
            add(Calendar.YEAR, 1)
          }
        }

        val intent = Intent(context, ReminderReceiver::class.java).apply {
          action = ACTION_BIRTHDAY
          putExtra(EXTRA_STUDENT_NAME, name)
        }
        val pendingIntent = PendingIntent.getBroadcast(
          context, 400 + i, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        
        alarmManager.setRepeating(AlarmManager.RTC_WAKEUP, alarmTime.timeInMillis, AlarmManager.INTERVAL_DAY * 365, pendingIntent)
      } catch (e: Exception) { Log.e(TAG, "Error scheduling birthday for $name: ${e.message}") }
    }
  }

  private fun scheduleWeeklyAlarm(
    context: Context,
    requestCode: Int,
    targetDayOfWeek: Int,
    hourOfDay: Int,
    minute: Int,
    title: String,
    body: String
  ) {
    val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as? AlarmManager ?: return
    val intent = Intent(context, ReminderReceiver::class.java).apply {
      action = "com.example.ACTION_SEND_REMINDER"
      putExtra(EXTRA_NOTIFICATION_TITLE, title)
      putExtra(EXTRA_NOTIFICATION_BODY, body)
      putExtra(EXTRA_NOTIFICATION_ID, requestCode)
    }
    val pendingIntent = PendingIntent.getBroadcast(
      context, requestCode, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )

    val calendar = Calendar.getInstance().apply {
      set(Calendar.DAY_OF_WEEK, targetDayOfWeek)
      set(Calendar.HOUR_OF_DAY, hourOfDay)
      set(Calendar.MINUTE, minute)
      set(Calendar.SECOND, 0)
      set(Calendar.MILLISECOND, 0)
      if (timeInMillis <= System.currentTimeMillis()) {
        add(Calendar.WEEK_OF_YEAR, 1)
      }
    }
    try {
      alarmManager.setRepeating(AlarmManager.RTC_WAKEUP, calendar.timeInMillis, AlarmManager.INTERVAL_DAY * 7, pendingIntent)
      Log.d(TAG, "Scheduled weekly alarm #$requestCode for day=$targetDayOfWeek at $hourOfDay:$minute")
    } catch (e: Exception) { Log.e(TAG, "Failed to schedule alarm #$requestCode", e) }
  }
}
