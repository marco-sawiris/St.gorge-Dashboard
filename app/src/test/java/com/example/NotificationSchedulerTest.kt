package com.example

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class NotificationSchedulerTest {

  @Test
  fun parsesIsoBirthdayDate() {
    assertEquals(11 to 5, NotificationScheduler.parseBirthdayMonthDay("2026-11-05"))
    assertEquals(11 to 5, NotificationScheduler.parseBirthdayMonthDay("2026/11/05"))
  }

  @Test
  fun parsesDayFirstGoogleSheetsBirthdayDate() {
    assertEquals(11 to 5, NotificationScheduler.parseBirthdayMonthDay("05/11/2026"))
    assertEquals(11 to 5, NotificationScheduler.parseBirthdayMonthDay("05/11"))
  }

  @Test
  fun rejectsInvalidBirthdayDates() {
    assertNull(NotificationScheduler.parseBirthdayMonthDay("31/02/2026"))
    assertNull(NotificationScheduler.parseBirthdayMonthDay("32/01/2026"))
    assertNull(NotificationScheduler.parseBirthdayMonthDay("2026-13-01"))
    assertNull(NotificationScheduler.parseBirthdayMonthDay("not-a-date"))
  }

  @Test
  fun acceptsLeapDayBirthday() {
    assertEquals(2 to 29, NotificationScheduler.parseBirthdayMonthDay("29/02/2000"))
  }
}
