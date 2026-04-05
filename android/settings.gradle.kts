pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
        maven { url = uri("https://jitpack.io") }
    }
}

rootProject.name = "ListenAI"
include(":app")
include(":paywallkit")
project(":paywallkit").projectDir = file("/Users/sushanthtiruvaipati/Documents/GitHub/PaywallKit-Android/paywallkit")
