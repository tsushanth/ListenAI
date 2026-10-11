package com.listenai.widget

import android.content.Context
import android.content.Intent
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.appwidget.action.actionStartActivity
import androidx.glance.action.clickable
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import androidx.glance.appwidget.cornerRadius
import androidx.glance.appwidget.provideContent
import androidx.glance.background
import androidx.glance.layout.Alignment
import androidx.glance.layout.Column
import androidx.glance.layout.Row
import androidx.glance.layout.Spacer
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.fillMaxWidth
import androidx.glance.layout.padding
import androidx.glance.layout.width
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextStyle
import androidx.glance.unit.ColorProvider
import com.listenai.MainActivity
import com.listenai.R
import com.listenai.data.local.ArticleDao
import com.listenai.data.models.Article
import kotlinx.coroutines.flow.first
import org.koin.core.context.GlobalContext

/**
 * Home-screen widget: resume the article you were last listening to, or read
 * whatever is on the clipboard. Shows the same cream/ink look as the app.
 */
class ReadAloudWidget : GlanceAppWidget() {

    override suspend fun provideGlance(context: Context, id: GlanceId) {
        // Koin is started in Application; if the process was cold-started just for the
        // widget it may not be ready, in which case fall back to the static layout.
        val article: Article? = runCatching {
            GlobalContext.getOrNull()?.get<ArticleDao>()?.getInProgressArticles()?.first()?.firstOrNull()
        }.getOrNull()

        provideContent { Content(context, article) }
    }

    @androidx.compose.runtime.Composable
    private fun Content(context: Context, article: Article?) {
        val ink = ColorProvider(Color(0xFF0B0B0B))
        val secondary = ColorProvider(Color(0xFF6E6E73))
        val cream = ColorProvider(Color(0xFFFFF9EA))

        Column(
            modifier = GlanceModifier.fillMaxSize().background(cream).cornerRadius(20.dp).padding(14.dp),
            verticalAlignment = Alignment.Vertical.CenterVertically
        ) {
            val resumeIntent = Intent(context, MainActivity::class.java).apply {
                action = ACTION_RESUME
                article?.let { putExtra(EXTRA_ARTICLE_ID, it.id) }
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
            }
            Column(modifier = GlanceModifier.fillMaxWidth().clickable(actionStartActivity(resumeIntent))) {
                Text(
                    text = context.getString(
                        if (article != null) R.string.widget_continue else R.string.widget_open
                    ),
                    style = TextStyle(color = secondary, fontSize = 12.sp, fontWeight = FontWeight.Medium)
                )
                Text(
                    text = article?.displayTitle ?: context.getString(R.string.app_name),
                    style = TextStyle(color = ink, fontSize = 16.sp, fontWeight = FontWeight.Bold),
                    maxLines = 2
                )
                if (article != null && article.totalDuration > 0) {
                    val percent = (article.lastPosition * 100 / article.totalDuration).toInt().coerceIn(0, 100)
                    Text(
                        text = context.getString(R.string.widget_percent_done, percent),
                        style = TextStyle(color = secondary, fontSize = 12.sp)
                    )
                }
            }

            Spacer(GlanceModifier.defaultWeight())

            val pasteIntent = Intent(context, MainActivity::class.java).apply {
                action = ACTION_PASTE_AND_READ
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
            }
            Row(
                modifier = GlanceModifier
                    .fillMaxWidth()
                    .background(ink)
                    .cornerRadius(18.dp)
                    .padding(vertical = 9.dp, horizontal = 14.dp)
                    .clickable(actionStartActivity(pasteIntent)),
                verticalAlignment = Alignment.Vertical.CenterVertically,
                horizontalAlignment = Alignment.Horizontal.CenterHorizontally
            ) {
                Text(
                    text = context.getString(R.string.widget_paste_and_read),
                    style = TextStyle(color = ColorProvider(Color.White), fontSize = 14.sp, fontWeight = FontWeight.Medium)
                )
            }
        }
    }

    companion object {
        const val ACTION_RESUME = "com.listenai.widget.RESUME"
        const val ACTION_PASTE_AND_READ = "com.listenai.widget.PASTE_AND_READ"
        const val EXTRA_ARTICLE_ID = "article_id"
    }
}

class ReadAloudWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = ReadAloudWidget()
}
