import {describe, it, expect, vi} from 'vitest'
import {nextTick} from 'vue'
import {flushPromises, mount} from '@vue/test-utils'
import {createI18n} from 'vue-i18n'
import {createRouter, createMemoryHistory} from 'vue-router'

import GanttChart from './GanttChart.vue'
import GanttTimelineHeader from './GanttTimelineHeader.vue'
import GanttVerticalGridLines from './GanttVerticalGridLines.vue'
import en from '@/i18n/lang/en.json'
import {i18n as globalI18n} from '@/i18n'
import {normalizeTask, type TaskResponse} from '@/client/queries/tasks'
import type {GanttFilters} from '@/views/project/helpers/useGanttFilters'

const i18n = createI18n({legacy: false, locale: 'en', messages: {en}})

// the dayjs locale sync reads the app-wide i18n instance, not the one installed on the wrapper
globalI18n.global.locale.value = 'en'
const router = createRouter({history: createMemoryHistory(), routes: [{path: '/', component: {template: '<div/>'}}]})

const FILTERS: GanttFilters = {
	projectId: 1,
	viewId: 1,
	dateFrom: '2026-08-01T00:00:00.000Z',
	dateTo: '2026-10-01T00:00:00.000Z',
	showTasksWithoutDates: false,
	zoom: 30,
	order: 'startDate',
}

function mountChart(isLoading: boolean) {
	return mount(GanttChart, {
		shallow: true,
		props: {
			isLoading,
			filters: FILTERS,
			tasks: new Map<number, TaskResponse>(),
			defaultTaskStartDate: FILTERS.dateFrom,
			defaultTaskEndDate: FILTERS.dateTo,
		},
		global: {
			plugins: [i18n, router],
		},
	})
}

describe('GanttChart.vue', () => {
	it('measures the day width once the chart replaces the loading state', async () => {
		const wrapper = mountChart(true)
		expect(wrapper.findComponent(GanttTimelineHeader).exists()).toBe(false)

		await wrapper.setProps({isLoading: false})

		expect(wrapper.findComponent(GanttTimelineHeader).props('dayWidthPixels')).toBeGreaterThan(0)
	})

	// jsdom reports a zero-width container, so the rendered day width is the zoom floor itself
	it('uses the zoom as the day width when the range does not fit', async () => {
		const wrapper = mountChart(false)
		await nextTick()
		const header = () => wrapper.findComponent(GanttTimelineHeader)
		expect(header().props('dayWidthPixels')).toBe(30)

		await wrapper.setProps({filters: {...FILTERS, zoom: 8}})
		await flushPromises()
		expect(header().props('dayWidthPixels')).toBe(8)
	})

	it('zooms with ctrl+wheel and asks the parent to store the new zoom', async () => {
		const wrapper = mountChart(false)
		await nextTick()
		const container = wrapper.find('.gantt-container')

		await container.trigger('wheel', {deltaY: -100, ctrlKey: true, clientX: 0})
		expect(wrapper.emitted('update:zoom')?.[0]).toEqual([45])

		await container.trigger('wheel', {deltaY: -100})
		expect(wrapper.emitted('update:zoom')).toHaveLength(1)
	})

	it('scrolls a date to the centre of the viewport', async () => {
		const wrapper = mountChart(false)
		await nextTick()
		const container = wrapper.find('.gantt-container').element as HTMLElement
		const scrollTo = vi.fn()
		container.scrollTo = scrollTo
		Object.defineProperty(container, 'clientWidth', {value: 600})

		// 2026-08-11 is 10 days after the range start, at 30px per day
		;(wrapper.vm as unknown as {scrollToDate: (date: Date) => void}).scrollToDate(new Date('2026-08-11T12:00:00'))

		expect(scrollTo).toHaveBeenCalledWith({left: 10 * 30 - 300 + 15, behavior: 'smooth'})
	})

	it('centres a date in the timeline that starts after the grip column', async () => {
		const wrapper = mountChart(false)
		await wrapper.setProps({reorderable: true})
		await nextTick()
		const container = wrapper.find('.gantt-container').element as HTMLElement
		const scrollTo = vi.fn()
		container.scrollTo = scrollTo
		Object.defineProperty(container, 'clientWidth', {value: 600})

		;(wrapper.vm as unknown as {scrollToDate: (date: Date) => void}).scrollToDate(new Date('2026-08-11T12:00:00'))

		expect(scrollTo).toHaveBeenCalledWith({left: 10 * 30 - (600 - 24) / 2 + 15, behavior: 'smooth'})
	})

	it('zooms with the keyboard', async () => {
		const wrapper = mountChart(false)
		await nextTick()
		const container = wrapper.find('.gantt-container')

		await container.trigger('keydown', {key: '+'})
		await container.trigger('keydown', {key: '0'})
		expect(wrapper.emitted('update:zoom')).toEqual([[45], [2]])
	})

	describe('manual row order', () => {
		function task(id: number, position: number): TaskResponse {
			return normalizeTask({
				id,
				title: `Task ${id}`,
				start_date: '2026-08-10T00:00:00.000Z',
				end_date: '2026-08-20T00:00:00.000Z',
				position,
				related_tasks: {},
			})
		}

		function mountReorderable(reorderable: boolean) {
			return mount(GanttChart, {
				shallow: true,
				props: {
					isLoading: false,
					filters: {...FILTERS, order: 'manual'},
					tasks: new Map([[1, task(1, 100)], [2, task(2, 200)], [3, task(3, 300)]]),
					defaultTaskStartDate: FILTERS.dateFrom,
					defaultTaskEndDate: FILTERS.dateTo,
					reorderable,
				},
				global: {
					plugins: [i18n, router],
					stubs: {GanttChartBody: false, GanttChartPrimitive: false, GanttRow: false, GanttRowPrimitive: false},
				},
			})
		}

		it('starts the timeline after the grip column only when rows can be reordered', () => {
			const offsets = (reorderable: boolean) => {
				const wrapper = mountReorderable(reorderable)
				return [GanttTimelineHeader, GanttVerticalGridLines].map(c => wrapper.findComponent(c).attributes('style') ?? '')
			}
			expect(offsets(true)).toEqual(['margin-inline-start: 24px;', 'inset-inline-start: 24px;'])
			expect(offsets(false)).toEqual(['margin-inline-start: 0px;', 'inset-inline-start: 0px;'])
		})

		it('shows a grip per row only when rows can be reordered', () => {
			expect(mountReorderable(true).findAll('.gantt-row-grip')).toHaveLength(3)
			expect(mountReorderable(false).findAll('.gantt-row-grip')).toHaveLength(0)
		})

		it('emits the new position when a row is dropped on another slot', async () => {
			const wrapper = mountReorderable(true)

			await wrapper.findAll('.gantt-row-grip')[2].trigger('pointerdown', {clientY: 100})
			document.dispatchEvent(new PointerEvent('pointermove', {clientY: 0}))
			await nextTick()
			expect(wrapper.find('.gantt-row-drop-indicator').exists()).toBe(true)

			document.dispatchEvent(new PointerEvent('pointerup'))
			await nextTick()
			expect(wrapper.emitted('update:position')).toEqual([[3, 50]])
			expect(wrapper.find('.gantt-row-drop-indicator').exists()).toBe(false)
		})
	})
})
