package com.rakazo.notifications

import android.content.Context

internal data class NotificationSettings(
  val liveConnection: Boolean = false,
  val messages: Boolean = true,
  val scheduledTasks: Boolean = true,
  val needsAttention: Boolean = true,
) {
  fun toMap() = mapOf(
    "liveConnection" to liveConnection,
    "messages" to messages,
    "scheduledTasks" to scheduledTasks,
    "needsAttention" to needsAttention,
  )

  companion object {
    fun fromMap(value: Map<String, Boolean>) = NotificationSettings(
      liveConnection = value["liveConnection"] ?: false,
      messages = value["messages"] ?: true,
      scheduledTasks = value["scheduledTasks"] ?: true,
      needsAttention = value["needsAttention"] ?: true,
    )
  }
}

internal class NotificationStorage(context: Context) {
  private val preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)

  var settings: NotificationSettings
    get() = NotificationSettings(
      liveConnection = preferences.getBoolean(LIVE, false),
      messages = preferences.getBoolean(MESSAGES, true),
      scheduledTasks = preferences.getBoolean(SCHEDULED, true),
      needsAttention = preferences.getBoolean(ATTENTION, true),
    )
    set(value) = commit {
      putBoolean(LIVE, value.liveConnection)
      putBoolean(MESSAGES, value.messages)
      putBoolean(SCHEDULED, value.scheduledTasks)
      putBoolean(ATTENTION, value.needsAttention)
    }

  var endpoint: String
    get() = preferences.getString(ENDPOINT, "").orEmpty()
    set(value) = commit { putString(ENDPOINT, value) }

  var spaceId: String
    get() = preferences.getString(SPACE_ID, "").orEmpty()
    set(value) = commit { putString(SPACE_ID, value) }

  private fun commit(change: android.content.SharedPreferences.Editor.() -> Unit) {
    check(preferences.edit().apply(change).commit()) { "Could not save notification settings" }
  }

  private companion object {
    const val PREFERENCES = "com.rakazo.notifications"
    const val LIVE = "live_connection"
    const val MESSAGES = "messages"
    const val SCHEDULED = "scheduled_tasks"
    const val ATTENTION = "needs_attention"
    const val ENDPOINT = "endpoint"
    const val SPACE_ID = "space_id"
  }
}
