import XCTest
@testable import ListenAI

// MARK: - Usage Tier Tests

final class UsageTierTests: XCTestCase {

    func testTierDisplayNames() {
        XCTAssertEqual(UsageTier.free.displayName, "Free")
        XCTAssertEqual(UsageTier.basic.displayName, "Basic")
        XCTAssertEqual(UsageTier.pro.displayName, "Pro")
        XCTAssertEqual(UsageTier.unlimited.displayName, "Unlimited")
    }

    func testTierDailyLimits() {
        XCTAssertEqual(UsageTier.free.dailyLimit, 10_000)
        XCTAssertEqual(UsageTier.basic.dailyLimit, 50_000)
        XCTAssertEqual(UsageTier.pro.dailyLimit, 200_000)
        XCTAssertEqual(UsageTier.unlimited.dailyLimit, Int.max)
    }

    func testTierMonthlyLimits() {
        XCTAssertEqual(UsageTier.free.monthlyLimit, 100_000)
        XCTAssertEqual(UsageTier.basic.monthlyLimit, 500_000)
        XCTAssertEqual(UsageTier.pro.monthlyLimit, 2_000_000)
        XCTAssertEqual(UsageTier.unlimited.monthlyLimit, Int.max)
    }

    func testTierSoftLimitPercentage() {
        XCTAssertEqual(UsageTier.free.softLimitPercentage, 0.8)
        XCTAssertEqual(UsageTier.basic.softLimitPercentage, 0.85)
        XCTAssertEqual(UsageTier.pro.softLimitPercentage, 0.9)
        XCTAssertEqual(UsageTier.unlimited.softLimitPercentage, 1.0)
    }

    func testTierLimitsIncreaseWithTier() {
        XCTAssertLessThan(UsageTier.free.dailyLimit, UsageTier.basic.dailyLimit)
        XCTAssertLessThan(UsageTier.basic.dailyLimit, UsageTier.pro.dailyLimit)
        XCTAssertLessThan(UsageTier.pro.dailyLimit, UsageTier.unlimited.dailyLimit)
    }
}

// MARK: - Usage Record Tests

final class UsageRecordTests: XCTestCase {

    func testUsageRecordCreation() {
        let record = UsageRecord(
            characterCount: 1000,
            provider: .elevenLabs,
            voiceID: "test-voice",
            articleID: UUID(),
            articleTitle: "Test Article"
        )

        XCTAssertEqual(record.characterCount, 1000)
        XCTAssertEqual(record.provider, .elevenLabs)
        XCTAssertEqual(record.voiceID, "test-voice")
        XCTAssertTrue(record.wasSuccessful)
        XCTAssertNil(record.errorMessage)
    }

    func testUsageRecordFormattedCharacterCount() {
        let smallRecord = UsageRecord(characterCount: 500, provider: .elevenLabs, voiceID: "test")
        XCTAssertEqual(smallRecord.formattedCharacterCount, "500")

        let mediumRecord = UsageRecord(characterCount: 5000, provider: .elevenLabs, voiceID: "test")
        XCTAssertEqual(mediumRecord.formattedCharacterCount, "5.0K")

        let largeRecord = UsageRecord(characterCount: 1_500_000, provider: .elevenLabs, voiceID: "test")
        XCTAssertEqual(largeRecord.formattedCharacterCount, "1.5M")
    }

    func testUsageRecordWithError() {
        let record = UsageRecord(
            characterCount: 0,
            provider: .openAI,
            voiceID: "test",
            wasSuccessful: false,
            errorMessage: "API Error"
        )

        XCTAssertFalse(record.wasSuccessful)
        XCTAssertEqual(record.errorMessage, "API Error")
    }
}

// MARK: - Usage Summary Tests

final class UsageSummaryTests: XCTestCase {

    func testEmptySummary() {
        let summary = UsageSummary.empty(period: .daily, tier: .free)

        XCTAssertEqual(summary.period, .daily)
        XCTAssertEqual(summary.totalCharacters, 0)
        XCTAssertEqual(summary.totalRequests, 0)
        XCTAssertEqual(summary.limit, UsageTier.free.dailyLimit)
        XCTAssertEqual(summary.usagePercentage, 0)
        XCTAssertFalse(summary.isOverLimit)
    }

    func testUsagePercentageCalculation() {
        let summary = UsageSummary(
            period: .daily,
            startDate: Date(),
            endDate: Date(),
            totalCharacters: 5000,
            totalRequests: 10,
            successfulRequests: 10,
            failedRequests: 0,
            charactersByProvider: [:],
            limit: 10000,
            tier: .free
        )

        XCTAssertEqual(summary.usagePercentage, 0.5, accuracy: 0.001)
        XCTAssertEqual(summary.remainingCharacters, 5000)
        XCTAssertFalse(summary.isOverLimit)
    }

    func testIsOverLimit() {
        let overLimitSummary = UsageSummary(
            period: .daily,
            startDate: Date(),
            endDate: Date(),
            totalCharacters: 15000,
            totalRequests: 20,
            successfulRequests: 20,
            failedRequests: 0,
            charactersByProvider: [:],
            limit: 10000,
            tier: .free
        )

        XCTAssertTrue(overLimitSummary.isOverLimit)
        XCTAssertGreaterThan(overLimitSummary.usagePercentage, 1.0)
        XCTAssertEqual(overLimitSummary.remainingCharacters, 0)
    }

    func testIsAtSoftLimit() {
        let atSoftLimit = UsageSummary(
            period: .daily,
            startDate: Date(),
            endDate: Date(),
            totalCharacters: 8500, // 85% of 10000
            totalRequests: 15,
            successfulRequests: 15,
            failedRequests: 0,
            charactersByProvider: [:],
            limit: 10000,
            tier: .free
        )

        XCTAssertTrue(atSoftLimit.isAtSoftLimit) // Free tier soft limit is 80%
        XCTAssertFalse(atSoftLimit.isOverLimit)
    }

    func testSuccessRate() {
        let summary = UsageSummary(
            period: .daily,
            startDate: Date(),
            endDate: Date(),
            totalCharacters: 5000,
            totalRequests: 10,
            successfulRequests: 8,
            failedRequests: 2,
            charactersByProvider: [:],
            limit: 10000,
            tier: .free
        )

        XCTAssertEqual(summary.successRate, 0.8, accuracy: 0.001)
    }

    func testFormattedValues() {
        let summary = UsageSummary(
            period: .monthly,
            startDate: Date(),
            endDate: Date(),
            totalCharacters: 75000,
            totalRequests: 100,
            successfulRequests: 100,
            failedRequests: 0,
            charactersByProvider: [:],
            limit: 100000,
            tier: .free
        )

        XCTAssertEqual(summary.formattedTotal, "75.0K")
        XCTAssertEqual(summary.formattedLimit, "100.0K")
        XCTAssertEqual(summary.formattedRemaining, "25.0K")
    }

    func testUnlimitedSummary() {
        let summary = UsageSummary(
            period: .monthly,
            startDate: Date(),
            endDate: Date(),
            totalCharacters: 1_000_000,
            totalRequests: 500,
            successfulRequests: 500,
            failedRequests: 0,
            charactersByProvider: [:],
            limit: Int.max,
            tier: .unlimited
        )

        XCTAssertEqual(summary.usagePercentage, 0)
        XCTAssertFalse(summary.isOverLimit)
        XCTAssertFalse(summary.isAtSoftLimit)
        XCTAssertEqual(summary.formattedLimit, "Unlimited")
    }
}

// MARK: - Usage Quota Tests

final class UsageQuotaTests: XCTestCase {

    func testCanUseCloudWhenUnderLimit() {
        let dailySummary = UsageSummary.empty(period: .daily, tier: .free)
        let monthlySummary = UsageSummary.empty(period: .monthly, tier: .free)

        let quota = UsageQuota(
            tier: .free,
            dailySummary: dailySummary,
            monthlySummary: monthlySummary
        )

        XCTAssertTrue(quota.canUseCloud)
        XCTAssertFalse(quota.shouldShowWarning)
        XCTAssertNil(quota.warningMessage)
        XCTAssertEqual(quota.warningLevel, .none)
    }

    func testCannotUseCloudWhenDailyExceeded() {
        let dailySummary = UsageSummary(
            period: .daily,
            startDate: Date(),
            endDate: Date(),
            totalCharacters: 15000,
            totalRequests: 20,
            successfulRequests: 20,
            failedRequests: 0,
            charactersByProvider: [:],
            limit: 10000,
            tier: .free
        )
        let monthlySummary = UsageSummary.empty(period: .monthly, tier: .free)

        let quota = UsageQuota(
            tier: .free,
            dailySummary: dailySummary,
            monthlySummary: monthlySummary
        )

        XCTAssertFalse(quota.canUseCloud)
        XCTAssertTrue(quota.shouldShowWarning)
        XCTAssertNotNil(quota.warningMessage)
        XCTAssertEqual(quota.warningLevel, .critical)
    }

    func testWarningWhenAtSoftLimit() {
        let dailySummary = UsageSummary(
            period: .daily,
            startDate: Date(),
            endDate: Date(),
            totalCharacters: 8500,
            totalRequests: 15,
            successfulRequests: 15,
            failedRequests: 0,
            charactersByProvider: [:],
            limit: 10000,
            tier: .free
        )
        let monthlySummary = UsageSummary.empty(period: .monthly, tier: .free)

        let quota = UsageQuota(
            tier: .free,
            dailySummary: dailySummary,
            monthlySummary: monthlySummary
        )

        XCTAssertTrue(quota.canUseCloud)
        XCTAssertTrue(quota.shouldShowWarning)
        XCTAssertNotNil(quota.warningMessage)
        XCTAssertGreaterThanOrEqual(quota.warningLevel, .medium)
    }
}

// MARK: - Warning Level Tests

final class WarningLevelTests: XCTestCase {

    func testWarningLevelComparable() {
        XCTAssertLessThan(WarningLevel.none, WarningLevel.low)
        XCTAssertLessThan(WarningLevel.low, WarningLevel.medium)
        XCTAssertLessThan(WarningLevel.medium, WarningLevel.high)
        XCTAssertLessThan(WarningLevel.high, WarningLevel.critical)
    }

    func testWarningLevelColors() {
        XCTAssertFalse(WarningLevel.none.color.isEmpty)
        XCTAssertFalse(WarningLevel.medium.color.isEmpty)
        XCTAssertFalse(WarningLevel.critical.color.isEmpty)
    }

    func testWarningLevelIcons() {
        XCTAssertFalse(WarningLevel.none.iconName.isEmpty)
        XCTAssertFalse(WarningLevel.medium.iconName.isEmpty)
        XCTAssertFalse(WarningLevel.critical.iconName.isEmpty)
    }
}

// MARK: - Usage Estimate Tests

final class UsageEstimateTests: XCTestCase {

    func testEstimateWithinLimits() {
        let estimate = UsageEstimate(
            characterCount: 5000,
            willExceedDailyLimit: false,
            willExceedMonthlyLimit: false,
            remainingAfterDaily: 5000,
            remainingAfterMonthly: 95000,
            estimatedDuration: 400,
            recommendedAction: .proceed
        )

        XCTAssertTrue(estimate.canProceed)
        XCTAssertEqual(estimate.recommendedAction, .proceed)
    }

    func testEstimateExceedingLimit() {
        let estimate = UsageEstimate(
            characterCount: 15000,
            willExceedDailyLimit: true,
            willExceedMonthlyLimit: false,
            remainingAfterDaily: 0,
            remainingAfterMonthly: 85000,
            estimatedDuration: 1200,
            recommendedAction: .waitForReset
        )

        XCTAssertFalse(estimate.canProceed)
        XCTAssertEqual(estimate.recommendedAction, .waitForReset)
    }

    func testEstimateFormattedDuration() {
        let shortEstimate = UsageEstimate(
            characterCount: 1000,
            willExceedDailyLimit: false,
            willExceedMonthlyLimit: false,
            remainingAfterDaily: 9000,
            remainingAfterMonthly: 99000,
            estimatedDuration: 30,
            recommendedAction: .proceed
        )
        XCTAssertEqual(shortEstimate.formattedDuration, "< 1 min")

        let mediumEstimate = UsageEstimate(
            characterCount: 10000,
            willExceedDailyLimit: false,
            willExceedMonthlyLimit: false,
            remainingAfterDaily: 0,
            remainingAfterMonthly: 90000,
            estimatedDuration: 1800, // 30 minutes
            recommendedAction: .proceed
        )
        XCTAssertEqual(mediumEstimate.formattedDuration, "30 min")

        let longEstimate = UsageEstimate(
            characterCount: 100000,
            willExceedDailyLimit: true,
            willExceedMonthlyLimit: false,
            remainingAfterDaily: 0,
            remainingAfterMonthly: 0,
            estimatedDuration: 5400, // 1 hr 30 min
            recommendedAction: .upgrade
        )
        XCTAssertEqual(longEstimate.formattedDuration, "1 hr 30 min")
    }

    func testRecommendedActionMessages() {
        XCTAssertFalse(UsageEstimate.RecommendedAction.proceed.message.isEmpty)
        XCTAssertFalse(UsageEstimate.RecommendedAction.useOnDevice.message.isEmpty)
        XCTAssertFalse(UsageEstimate.RecommendedAction.splitContent.message.isEmpty)
        XCTAssertFalse(UsageEstimate.RecommendedAction.waitForReset.message.isEmpty)
        XCTAssertFalse(UsageEstimate.RecommendedAction.upgrade.message.isEmpty)
    }
}

// MARK: - Daily Usage Tests

final class DailyUsageTests: XCTestCase {

    func testDailyUsageCreation() {
        let usage = DailyUsage(date: Date())

        XCTAssertEqual(usage.totalCharacters, 0)
        XCTAssertEqual(usage.totalRequests, 0)
        XCTAssertEqual(usage.successfulRequests, 0)
        XCTAssertTrue(usage.records.isEmpty)
    }

    func testDailyUsageAddRecord() {
        var usage = DailyUsage(date: Date())

        let record = UsageRecord(
            characterCount: 1000,
            provider: .elevenLabs,
            voiceID: "test"
        )

        usage.addRecord(record)

        XCTAssertEqual(usage.totalCharacters, 1000)
        XCTAssertEqual(usage.totalRequests, 1)
        XCTAssertEqual(usage.successfulRequests, 1)
        XCTAssertEqual(usage.records.count, 1)
    }

    func testDailyUsageMultipleRecords() {
        var usage = DailyUsage(date: Date())

        usage.addRecord(UsageRecord(characterCount: 1000, provider: .elevenLabs, voiceID: "v1"))
        usage.addRecord(UsageRecord(characterCount: 2000, provider: .openAI, voiceID: "v2"))
        usage.addRecord(UsageRecord(characterCount: 500, provider: .elevenLabs, voiceID: "v1", wasSuccessful: false, errorMessage: "Error"))

        XCTAssertEqual(usage.totalCharacters, 3500)
        XCTAssertEqual(usage.totalRequests, 3)
        XCTAssertEqual(usage.successfulRequests, 2)
    }

    func testDailyUsageDateKey() {
        let date = Date()
        let usage = DailyUsage(date: date)

        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd"
        let expectedKey = formatter.string(from: date)

        XCTAssertEqual(usage.dateKey, expectedKey)
    }
}

// MARK: - Monthly Usage Tests

final class MonthlyUsageTests: XCTestCase {

    func testMonthlyUsageCreation() {
        let usage = MonthlyUsage(year: 2024, month: 6)

        XCTAssertEqual(usage.year, 2024)
        XCTAssertEqual(usage.month, 6)
        XCTAssertEqual(usage.totalCharacters, 0)
        XCTAssertEqual(usage.monthKey, "2024-06")
    }

    func testMonthlyUsageFromDate() {
        let usage = MonthlyUsage(from: Date())

        let components = Calendar.current.dateComponents([.year, .month], from: Date())
        XCTAssertEqual(usage.year, components.year)
        XCTAssertEqual(usage.month, components.month)
    }

    func testMonthlyUsageAddRecord() {
        var usage = MonthlyUsage(year: 2024, month: 6)

        let record = UsageRecord(
            characterCount: 5000,
            provider: .elevenLabs,
            voiceID: "test"
        )

        usage.addRecord(record)

        XCTAssertEqual(usage.totalCharacters, 5000)
        XCTAssertEqual(usage.totalRequests, 1)
        XCTAssertFalse(usage.dailyUsage.isEmpty)
    }
}

// MARK: - Helper Function Tests

final class UsageHelperTests: XCTestCase {

    func testFormatCharacterCount() {
        XCTAssertEqual(formatCharacterCount(500), "500")
        XCTAssertEqual(formatCharacterCount(1000), "1.0K")
        XCTAssertEqual(formatCharacterCount(5500), "5.5K")
        XCTAssertEqual(formatCharacterCount(1_000_000), "1.0M")
        XCTAssertEqual(formatCharacterCount(2_500_000), "2.5M")
    }

    func testDateRangeForDaily() {
        let now = Date()
        let (start, end) = dateRange(for: .daily, from: now)

        XCTAssertTrue(Calendar.current.isDateInToday(start))
        XCTAssertLessThan(start, end)

        let interval = end.timeIntervalSince(start)
        XCTAssertEqual(interval, 86400, accuracy: 1) // 24 hours
    }

    func testDateRangeForMonthly() {
        let now = Date()
        let (start, end) = dateRange(for: .monthly, from: now)

        let startComponents = Calendar.current.dateComponents([.year, .month, .day], from: start)
        XCTAssertEqual(startComponents.day, 1)

        XCTAssertLessThan(start, end)
    }
}

// MARK: - Usage Period Tests

final class UsagePeriodTests: XCTestCase {

    func testPeriodDisplayNames() {
        XCTAssertEqual(UsagePeriod.daily.displayName, "Today")
        XCTAssertEqual(UsagePeriod.monthly.displayName, "This Month")
        XCTAssertEqual(UsagePeriod.allTime.displayName, "All Time")
    }

    func testPeriodShortNames() {
        XCTAssertEqual(UsagePeriod.daily.shortName, "Daily")
        XCTAssertEqual(UsagePeriod.monthly.shortName, "Monthly")
        XCTAssertEqual(UsagePeriod.allTime.shortName, "Total")
    }
}
