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

class ReminderReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent?) {
    if (intent?.action == Intent.ACTION_BOOT_COMPLETED) {
      Log.d("ReminderReceiver", "Device rebooted, rescheduling weekly alarms")
      NotificationScheduler.scheduleAllWeeklyReminders(context)
      return
    }

    val title = intent?.getStringExtra(EXTRA_NOTIFICATION_TITLE) ?: "فصل الشهيد مارجرجس"
    val body = intent?.getStringExtra(EXTRA_NOTIFICATION_BODY) ?: "تذكير جديد لخدمة فصل مارجرجس"
    val notifId = intent?.getIntExtra(EXTRA_NOTIFICATION_ID, 100) ?: 100

    NotificationScheduler.showLocalNotification(context, title, body, notifId, CHANNEL_ID_REMINDERS)
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

  /**
   * جدولة كافة التنبيهات الأسبوعية المستمرة:
   * 1. الأربعاء 11:00 صباحاً (تذكير الافتقاد)
   * 2. الأربعاء 8:30 مساءً (تذكير التحضير)
   * 3. الخميس 6:00 مساءً (آخر عملية افتقاد قبل الجمعة)
   * 4. الجمعة 2:00 ظهراً (تسجيل الحضور والغياب)
   */
  fun scheduleAllWeeklyReminders(context: Context) {
    createNotificationChannels(context)

    // 1. الأربعاء 11:00 ص — تذكير الافتقاد
    scheduleWeeklyAlarm(
      context = context,
      requestCode = 201,
      targetDayOfWeek = Calendar.WEDNESDAY,
      hourOfDay = 11,
      minute = 0,
      title = "📞 تذكير الافتقاد الأسبوعي — فصل مارجرجس",
      body = "منتصف الأسبوع: تابع مخدوميك وافتقد باقي الأسماء لتنسيق الحضور والقداس مبكراً!"
    )

    // 2. الأربعاء 8:30 م — تذكير التحضير
    scheduleWeeklyAlarm(
      context = context,
      requestCode = 202,
      targetDayOfWeek = Calendar.WEDNESDAY,
      hourOfDay = 20,
      minute = 30,
      title = "📖 تذكير بتحضير درس مدارس الأحد",
      body = "وقت الصلاة والتحضير لخدمة أولادنا الحبيبة.. جهّز درسك وأنشطتك بفرح لجمعة مباركة ✨"
    )

    // 3. الخميس 6:00 م — آخر فرصة للافتقاد
    scheduleWeeklyAlarm(
      context = context,
      requestCode = 203,
      targetDayOfWeek = Calendar.THURSDAY,
      hourOfDay = 18,
      minute = 0,
      title = "🕊️ آخر عملية افتقاد قبل الجمعة",
      body = "الخميس مساءً: اطمئن على باقي المخدومين تليفونياً وأكد عليهم ميعاد القداس وفصل مارجرجس غداً!"
    )

    // 4. الجمعة 2:00 ظهراً — تسجيل الحضور والغياب
    scheduleWeeklyAlarm(
      context = context,
      requestCode = 204,
      targetDayOfWeek = Calendar.FRIDAY,
      hourOfDay = 14,
      minute = 0,
      title = "📋 تسجيل الحضور والغياب الآن",
      body = "الساعة 2 ظهراً: حان موعد تسجيل الحضور والغياب لمخدوميك في فصل مارجرجس عبر التطبيق ✅"
    )
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
      context,
      requestCode,
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )

    val calendar = Calendar.getInstance().apply {
      set(Calendar.DAY_OF_WEEK, targetDayOfWeek)
      set(Calendar.HOUR_OF_DAY, hourOfDay)
      set(Calendar.MINUTE, minute)
      set(Calendar.SECOND, 0)
      set(Calendar.MILLISECOND, 0)
      // إذا كان الوقت قد فات هذا الأسبوع، الانتقال للأسبوع القادم
      if (timeInMillis <= System.currentTimeMillis()) {
        add(Calendar.WEEK_OF_YEAR, 1)
      }
    }

    try {
      alarmManager.setRepeating(
        AlarmManager.RTC_WAKEUP,
        calendar.timeInMillis,
        AlarmManager.INTERVAL_DAY * 7,
        pendingIntent
      )
      Log.d(TAG, "Scheduled weekly alarm #$requestCode for day=$targetDayOfWeek at $hourOfDay:$minute")
    } catch (e: Exception) {
      Log.e(TAG, "Failed to schedule alarm #$requestCode", e)
    }
  }
}
