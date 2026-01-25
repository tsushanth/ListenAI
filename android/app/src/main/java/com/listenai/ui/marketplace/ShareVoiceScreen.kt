package com.listenai.ui.marketplace

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.listenai.service.marketplace.VoiceMarketplaceService
import com.listenai.service.voice.VoiceCloningService
import com.listenai.service.voice.VoiceCloningService.ClonedVoice
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun ShareVoiceScreen(
    onNavigateBack: () -> Unit,
    onShareComplete: () -> Unit
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val voiceCloningService = remember { VoiceCloningService.getInstance(context) }
    val marketplaceService = remember { VoiceMarketplaceService.getInstance(context) }

    var clonedVoices by remember { mutableStateOf<List<ClonedVoice>>(emptyList()) }
    var selectedVoice by remember { mutableStateOf<ClonedVoice?>(null) }
    var displayName by remember { mutableStateOf("") }
    var description by remember { mutableStateOf("") }
    var selectedTags by remember { mutableStateOf<Set<String>>(emptySet()) }
    var attestationChecked by remember { mutableStateOf(false) }
    var termsChecked by remember { mutableStateOf(false) }

    var isLoading by remember { mutableStateOf(true) }
    var isSubmitting by remember { mutableStateOf(false) }
    var errorMessage by remember { mutableStateOf<String?>(null) }

    val availableTags = listOf(
        "male", "female", "neutral",
        "expressive", "calm", "energetic",
        "deep", "warm", "bright",
        "professional", "casual", "storytelling"
    )

    fun loadVoices() {
        scope.launch {
            isLoading = true
            try {
                clonedVoices = voiceCloningService.listClonedVoices(forceRefresh = true)
            } catch (e: Exception) {
                errorMessage = "Failed to load voices: ${e.message}"
            } finally {
                isLoading = false
            }
        }
    }

    fun shareVoice() {
        val voice = selectedVoice ?: return
        if (displayName.isEmpty()) {
            errorMessage = "Please enter a display name"
            return
        }
        if (!attestationChecked || !termsChecked) {
            errorMessage = "Please accept the attestation and terms"
            return
        }

        scope.launch {
            isSubmitting = true
            errorMessage = null
            try {
                marketplaceService.shareVoice(
                    clonedVoiceId = voice.id,
                    displayName = displayName,
                    description = description.takeIf { it.isNotEmpty() },
                    tags = selectedTags.toList(),
                    attestation = "I confirm this is my own voice"
                )
                onShareComplete()
            } catch (e: VoiceMarketplaceService.MarketplaceError.AlreadyShared) {
                errorMessage = "This voice is already shared"
            } catch (e: Exception) {
                errorMessage = e.message ?: "Failed to share voice"
            } finally {
                isSubmitting = false
            }
        }
    }

    LaunchedEffect(Unit) {
        loadVoices()
    }

    LaunchedEffect(selectedVoice) {
        selectedVoice?.let { voice ->
            if (displayName.isEmpty()) {
                displayName = voice.name
            }
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Share Voice") },
                navigationIcon = {
                    IconButton(onClick = onNavigateBack) {
                        Icon(Icons.Default.ArrowBack, contentDescription = "Back")
                    }
                }
            )
        }
    ) { paddingValues ->
        when {
            isLoading -> {
                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(paddingValues),
                    contentAlignment = Alignment.Center
                ) {
                    CircularProgressIndicator()
                }
            }
            clonedVoices.isEmpty() -> {
                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(paddingValues),
                    contentAlignment = Alignment.Center
                ) {
                    Column(
                        horizontalAlignment = Alignment.CenterHorizontally,
                        modifier = Modifier.padding(32.dp)
                    ) {
                        Icon(
                            Icons.Default.RecordVoiceOver,
                            contentDescription = null,
                            modifier = Modifier.size(64.dp),
                            tint = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                        Spacer(modifier = Modifier.height(16.dp))
                        Text(
                            "No cloned voices",
                            style = MaterialTheme.typography.titleMedium
                        )
                        Text(
                            "Create a cloned voice first to share it",
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                }
            }
            else -> {
                Column(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(paddingValues)
                        .verticalScroll(rememberScrollState())
                        .padding(16.dp)
                ) {
                    // Select voice
                    Text(
                        "Select Voice",
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.SemiBold
                    )
                    Spacer(modifier = Modifier.height(8.dp))

                    clonedVoices.forEach { voice ->
                        Card(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(vertical = 4.dp),
                            shape = RoundedCornerShape(12.dp),
                            colors = CardDefaults.cardColors(
                                containerColor = if (selectedVoice?.id == voice.id)
                                    MaterialTheme.colorScheme.primaryContainer
                                else MaterialTheme.colorScheme.surface
                            ),
                            onClick = { selectedVoice = voice }
                        ) {
                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(12.dp),
                                verticalAlignment = Alignment.CenterVertically
                            ) {
                                RadioButton(
                                    selected = selectedVoice?.id == voice.id,
                                    onClick = { selectedVoice = voice }
                                )
                                Spacer(modifier = Modifier.width(8.dp))
                                Column {
                                    Text(
                                        voice.name,
                                        style = MaterialTheme.typography.bodyLarge,
                                        fontWeight = FontWeight.Medium
                                    )
                                    voice.durationSec?.let { duration ->
                                        Text(
                                            "${String.format("%.1f", duration)}s sample",
                                            style = MaterialTheme.typography.bodySmall,
                                            color = MaterialTheme.colorScheme.onSurfaceVariant
                                        )
                                    }
                                }
                            }
                        }
                    }

                    Spacer(modifier = Modifier.height(24.dp))

                    // Display name
                    OutlinedTextField(
                        value = displayName,
                        onValueChange = { displayName = it },
                        label = { Text("Display Name") },
                        placeholder = { Text("How this voice will appear in the marketplace") },
                        modifier = Modifier.fillMaxWidth(),
                        singleLine = true
                    )

                    Spacer(modifier = Modifier.height(16.dp))

                    // Description
                    OutlinedTextField(
                        value = description,
                        onValueChange = { description = it },
                        label = { Text("Description (optional)") },
                        placeholder = { Text("Describe your voice...") },
                        modifier = Modifier.fillMaxWidth(),
                        maxLines = 3
                    )

                    Spacer(modifier = Modifier.height(24.dp))

                    // Tags
                    Text(
                        "Tags",
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.SemiBold
                    )
                    Text(
                        "Select tags that describe your voice",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    Spacer(modifier = Modifier.height(8.dp))

                    FlowRow(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        verticalArrangement = Arrangement.spacedBy(8.dp)
                    ) {
                        availableTags.forEach { tag ->
                            FilterChip(
                                selected = tag in selectedTags,
                                onClick = {
                                    selectedTags = if (tag in selectedTags) {
                                        selectedTags - tag
                                    } else if (selectedTags.size < 5) {
                                        selectedTags + tag
                                    } else {
                                        selectedTags
                                    }
                                },
                                label = { Text(tag.replaceFirstChar { it.uppercase() }) }
                            )
                        }
                    }

                    Spacer(modifier = Modifier.height(24.dp))

                    // Attestation
                    Card(
                        modifier = Modifier.fillMaxWidth(),
                        shape = RoundedCornerShape(12.dp),
                        colors = CardDefaults.cardColors(
                            containerColor = MaterialTheme.colorScheme.surfaceVariant
                        )
                    ) {
                        Column(modifier = Modifier.padding(16.dp)) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Checkbox(
                                    checked = attestationChecked,
                                    onCheckedChange = { attestationChecked = it }
                                )
                                Spacer(modifier = Modifier.width(8.dp))
                                Text(
                                    "I confirm this is my own voice and I have the right to share it",
                                    style = MaterialTheme.typography.bodyMedium
                                )
                            }

                            Spacer(modifier = Modifier.height(8.dp))

                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Checkbox(
                                    checked = termsChecked,
                                    onCheckedChange = { termsChecked = it }
                                )
                                Spacer(modifier = Modifier.width(8.dp))
                                Text(
                                    "I agree to the Voice Marketplace Terms of Service",
                                    style = MaterialTheme.typography.bodyMedium
                                )
                            }
                        }
                    }

                    // Error message
                    errorMessage?.let { error ->
                        Spacer(modifier = Modifier.height(16.dp))
                        Card(
                            colors = CardDefaults.cardColors(
                                containerColor = MaterialTheme.colorScheme.errorContainer
                            )
                        ) {
                            Row(
                                modifier = Modifier.padding(12.dp),
                                verticalAlignment = Alignment.CenterVertically
                            ) {
                                Icon(
                                    Icons.Default.Error,
                                    contentDescription = null,
                                    tint = MaterialTheme.colorScheme.onErrorContainer
                                )
                                Spacer(modifier = Modifier.width(8.dp))
                                Text(
                                    error,
                                    color = MaterialTheme.colorScheme.onErrorContainer
                                )
                            }
                        }
                    }

                    Spacer(modifier = Modifier.height(24.dp))

                    // Share button
                    Button(
                        onClick = { shareVoice() },
                        modifier = Modifier
                            .fillMaxWidth()
                            .height(56.dp),
                        enabled = selectedVoice != null &&
                                displayName.isNotEmpty() &&
                                attestationChecked &&
                                termsChecked &&
                                !isSubmitting,
                        shape = RoundedCornerShape(28.dp)
                    ) {
                        if (isSubmitting) {
                            CircularProgressIndicator(
                                modifier = Modifier.size(24.dp),
                                color = MaterialTheme.colorScheme.onPrimary
                            )
                        } else {
                            Icon(Icons.Default.Share, contentDescription = null)
                            Spacer(modifier = Modifier.width(8.dp))
                            Text("Share Voice")
                        }
                    }

                    Spacer(modifier = Modifier.height(32.dp))
                }
            }
        }
    }
}
